import { createRequire } from "module";
import { workspacePath } from "@markedesk/plugin-sdk";
import { LOG } from "@/identidade";

/**
 * O banco próprio do plugin — SQLite, num arquivo no workspace.
 *
 * ## Por que existe
 *
 * Até a 0.1.11 todo o estado do plugin vivia no `PluginStorage`, que é uma
 * tabela chave-valor DENTRO DO BACKEND do Markedesk, alcançada por HTTP. Isso
 * cobrava três preços:
 *
 * 1. **O vínculo ticket↔chamado dependia do backend estar no ar.** O próprio
 *    código registrava isso: ao falhar a gravação, o comentário dizia "o que se
 *    perde é o vínculo depois de um restart do plugin". Vínculo perdido é
 *    chamado órfão — as mensagens seguintes do atendimento não sabem onde
 *    entrar, e ninguém percebe até o cliente reclamar.
 * 2. **Não havia como CONSULTAR nada.** Chave-valor por `ticket:{id}` responde
 *    "qual o chamado deste ticket" e mais nada: não dá para listar os vínculos
 *    do dia, achar o ticket de um protocolo, nem contar quantos chamados o
 *    plugin abriu. Era por isso que existia o `webhookVinculo`, mandando cada
 *    vínculo para o n8n gravar na tabela `comunica` — uma volta pela rede para
 *    ter o que já estava na mão. Ele saiu na 0.3.0: o dado mora aqui.
 * 3. **O diagnóstico era um array reescrito inteiro.** 200 eventos no teto,
 *    regravados por completo a cada rajada de log, sem filtro possível no
 *    servidor.
 *
 * SQLite resolve os três de uma vez, e o arquivo fica no volume que já é
 * carregado pelo provisionamento (`${STACK_NAME}-data:/app/data`) — o mesmo
 * lugar do `plugin-config.json`, cuja perda já deixaria o plugin
 * desprovisionado. Ou seja: não é durabilidade nova para proteger, é a mesma
 * que já existe.
 *
 * ## Por que `node:sqlite` e não `better-sqlite3`
 *
 * `node:sqlite` é módulo nativo do Node — **zero dependências**. O
 * `better-sqlite3` é módulo compilado: no Alpine (musl) ele não tem binário
 * pronto e compila do zero, o que exigiria `python3`, `make` e `g++` no estágio
 * de build e engordaria a imagem de um plugin que hoje não tem uma única
 * dependência nativa.
 *
 * O preço é a versão do Node: `node:sqlite` nasceu no 22.5 atrás da flag
 * `--experimental-sqlite` e só dispensa a flag a partir do **24**. Por isso o
 * Dockerfile subiu de `node:20-alpine` para `node:24-alpine`.
 *
 * ## Escrita síncrona
 *
 * `DatabaseSync` é síncrono de propósito — é a API que o `node:sqlite` oferece
 * e é a certa aqui: SQLite local não espera rede, e um `await` por leitura de
 * vínculo só adicionaria cerimônia. O processo é único e single-threaded, então
 * não há escritor concorrente dentro dele.
 */

/** Uma consulta já compilada. Ver `preparado`, que as reaproveita. */
export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

/** O handle do banco, no formato que os repositórios usam. */
export interface Banco {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

/**
 * As migrações, em ordem. O índice + 1 é a versão.
 *
 * Versionado por `PRAGMA user_version` — o contador que o próprio SQLite
 * guarda no arquivo. Sem isso, "o schema já está aplicado?" viraria um
 * `CREATE TABLE IF NOT EXISTS` que não sabe adicionar coluna numa base que já
 * existe, e a primeira alteração de schema teria de ser descoberta à mão.
 */
const MIGRACOES: string[] = [
  // ── 1: vínculos e eventos ────────────────────────────────────────
  `
  /*
   * Um atendimento do Markedesk e o chamado dele no TomTicket.
   *
   * Os campos escalares são COLUNAS, e não um JSON numa coluna só, porque é o
   * que torna o banco útil: "qual o ticket do protocolo 74128", "quantos
   * chamados abertos hoje", "quais ficaram com setor pendente" são perguntas
   * que o suporte faz e que um blob não responde.
   */
  CREATE TABLE vinculos (
    ticket_id             TEXT PRIMARY KEY,
    chamado_id            TEXT NOT NULL,
    protocolo             TEXT,
    departamento_id       TEXT,
    departamento_pendente TEXT,
    operador_atual        TEXT,
    cliente_email         TEXT NOT NULL,
    fila_id               TEXT,
    finalizado            INTEGER NOT NULL DEFAULT 0,
    finalizado_por        TEXT,
    criado_em             TEXT NOT NULL,
    atualizado_em         TEXT NOT NULL
  );

  /* O protocolo é como a pessoa chega ("o chamado 74128"), então é por ele que
     se busca o ticket — o caminho inverso do uso normal. */
  CREATE INDEX idx_vinculos_protocolo ON vinculos (protocolo);
  CREATE INDEX idx_vinculos_criado ON vinculos (criado_em);

  /*
   * Áudios já transcritos num chamado, para não transcrever duas vezes.
   *
   * Tabela filha, e não um array no vínculo: como array ele vinha com um teto
   * arbitrário de 50 ("MAXIMO_TRANSCRITOS") justamente porque reescrever a
   * lista inteira a cada áudio pesava. Aqui cada áudio é uma linha, o teto
   * deixa de existir e a checagem "já transcrevi este?" vira uma chave única.
   */
  CREATE TABLE transcricoes (
    ticket_id TEXT NOT NULL,
    wid       TEXT NOT NULL,
    quando    TEXT NOT NULL,
    PRIMARY KEY (ticket_id, wid),
    FOREIGN KEY (ticket_id) REFERENCES vinculos (ticket_id) ON DELETE CASCADE
  );

  /*
   * As linhas de log do plugin — o que a aba Diagnóstico mostra.
   *
   * Append-only: cada log é um INSERT, em vez de reescrever um array de 200.
   * A coluna eh_chamado é calculada na GRAVAÇÃO porque a aba filtra por isso; decidir
   * na leitura obrigaria a repetir, em SQL, a expressão regular que a tela já
   * usava — duas verdades para a mesma pergunta.
   */
  CREATE TABLE eventos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    quando     TEXT NOT NULL,
    nivel      TEXT NOT NULL,
    texto      TEXT NOT NULL,
    eh_chamado INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX idx_eventos_quando ON eventos (id DESC);
  CREATE INDEX idx_eventos_nivel ON eventos (nivel);

  /* Marcas de coisas feitas uma única vez (ex.: a importação do PluginStorage).
     Fica no banco, e não num arquivo ao lado, para a marca viver e morrer junto
     com os dados que ela descreve. */
  CREATE TABLE marcos (
    nome   TEXT PRIMARY KEY,
    quando TEXT NOT NULL
  );
  `,

  // ── 2: o que só ia para a tabela `comunica` ──────────────────────
  `
  /*
   * Até a 0.2.0 estes três campos existiam apenas no POST para o n8n, que os
   * gravava no Postgres (tabela comunica). Com o webhook fora, eles não têm
   * mais para onde ir — e são justamente o que responde "de que canal veio" e
   * "sobre o que era" sem abrir o chamado no TomTicket.
   *
   * ALTER TABLE ... ADD COLUMN, e não uma tabela nova: são atributos do mesmo
   * vínculo, um por linha. Em SQLite o ADD COLUMN é instantâneo (só reescreve o
   * schema) e as linhas antigas ficam com NULL, que é a verdade — o plugin
   * nunca soube esses valores para elas.
   */
  ALTER TABLE vinculos ADD COLUMN categoria_id TEXT;
  ALTER TABLE vinculos ADD COLUMN mensagem     TEXT;
  ALTER TABLE vinculos ADD COLUMN canal        TEXT;
  `,

  // ── 3: índices que faltavam (medidos com EXPLAIN QUERY PLAN) ─────
  `
  /*
   * A busca da tela é "protocolo = ? OR chamado_id = ?", porque a pessoa tanto
   * cita o número quanto cola o hash. Só o protocolo tinha índice — e um OR em
   * que um lado não é indexado não permite a união de índices: o SQLite
   * desistia dos dois e varria a tabela (SCAN vinculos). Com os dois indexados
   * ele faz duas buscas e junta.
   */
  CREATE INDEX idx_vinculos_chamado ON vinculos (chamado_id);

  /*
   * "Os que estão abertos, mais recentes primeiro" é a consulta da tela e a
   * mais frequente. Índice parcial: só as linhas abertas entram, e já na ordem
   * da listagem — o SQLite lê as 50 primeiras e para, em vez de percorrer o
   * histórico inteiro em busca das que sobraram abertas. Parcial também o
   * mantém pequeno: vínculo finalizado, que é a maioria com o tempo, não ocupa
   * espaço nele.
   */
  CREATE INDEX idx_vinculos_abertos ON vinculos (criado_em DESC) WHERE finalizado = 0;

  /*
   * A aba Diagnóstico conta as linhas "de chamado" a cada abertura, e isso
   * varria a tabela de eventos inteira (até 5.000 linhas). Parcial pelo mesmo
   * motivo: as linhas de chamado são a minoria.
   */
  CREATE INDEX idx_eventos_chamado ON eventos (id DESC) WHERE eh_chamado = 1;
  `
];

/** Nome do arquivo no workspace. */
export const ARQUIVO_PADRAO = "tomticket.db";

/** O caminho do banco: `/app/data/tomticket.db` no container. */
export function caminhoDoBanco(): string {
  return workspacePath(ARQUIVO_PADRAO);
}

/**
 * Aplica as migrações que faltam.
 *
 * Cada uma roda dentro de uma transação junto com o avanço do `user_version`:
 * sem isso, uma migração que falhasse no meio deixaria o schema pela metade
 * com a versão já marcada como aplicada — e a próxima subida não tentaria de
 * novo.
 */
export function migrar(banco: Banco): number {
  const atual = Number(banco.prepare("PRAGMA user_version").get()?.user_version ?? 0);

  for (let versao = atual; versao < MIGRACOES.length; versao++) {
    banco.exec("BEGIN");
    try {
      banco.exec(MIGRACOES[versao]);
      // `user_version` não aceita parâmetro ligado — é PRAGMA, não expressão.
      // O valor vem do laço, nunca de fora, então não há injeção possível.
      banco.exec(`PRAGMA user_version = ${versao + 1}`);
      banco.exec("COMMIT");
      console.log(`${LOG} banco migrado para a versão ${versao + 1}`);
    } catch (err) {
      banco.exec("ROLLBACK");
      throw err;
    }
  }

  return MIGRACOES.length;
}

/**
 * Carrega o `node:sqlite`.
 *
 * Por `createRequire`, e não por `import` no topo nem `import()` dinâmico, por
 * dois motivos que se somam:
 *
 * 1. **A mensagem de erro.** Num Node antigo o módulo não existe, e um import
 *    estático derrubaria o plugin no boot com "Cannot find module
 *    'node:sqlite'" — que não diz a quem lê que o problema é a VERSÃO do Node.
 *    Aqui a falha vem explicada.
 * 2. **O Vite.** O `vitest` roda os testes pelo transformador do Vite, que
 *    tenta RESOLVER todo import — inclusive o dinâmico — e não reconhece
 *    `node:sqlite` como builtin (o módulo é mais novo que a lista dele). Ele
 *    descarta o prefixo e falha procurando um pacote chamado "sqlite". Um
 *    `require` em tempo de execução não é reescrito, então o mesmo código roda
 *    no teste e em produção.
 */
function carregarSqlite(): new (caminho: string) => Banco {
  try {
    const exigir = createRequire(import.meta.url);
    return exigir("node:sqlite").DatabaseSync;
  } catch {
    throw new Error(
      `${LOG} este plugin precisa do módulo nativo node:sqlite, que exige Node 24 ou mais novo ` +
        `(Node em uso: ${process.version}). No Docker, use a imagem node:24-alpine.`
    );
  }
}

/** Abre o banco, cria o arquivo se não existir e migra. */
/**
 * O caminho de cada banco aberto.
 *
 * `WeakMap`, e não uma propriedade enfiada no handle nem uma variável de
 * módulo: a primeira mutaria um objeto que não é nosso, e a segunda guardaria
 * o caminho de UM banco — errado no modo multi-tenant, onde cada empresa abre
 * o seu. A chave fraca também solta o registro quando o handle é coletado.
 */
const caminhoAberto = new WeakMap<Banco, string>();

export function abrirBanco(caminho = caminhoDoBanco()): Banco {
  const DatabaseSync = carregarSqlite();
  const banco = new DatabaseSync(caminho);
  caminhoAberto.set(banco, caminho);

  /*
   * WAL: o leitor não espera o escritor.
   *
   * Importa menos por concorrência (o processo é único) e mais por
   * durabilidade: no modo padrão, um container morto no meio de uma gravação
   * pode deixar o arquivo com uma transação pela metade. Com WAL o commit é
   * um append, e a recuperação no próximo boot é automática.
   *
   * `synchronous = NORMAL` em vez de FULL: o vínculo é dado operacional, não
   * financeiro, e FULL cobraria um fsync por commit — a cada mensagem de cada
   * atendimento.
   */
  banco.exec("PRAGMA journal_mode = WAL");
  banco.exec("PRAGMA synchronous = NORMAL");
  banco.exec("PRAGMA foreign_keys = ON");
  // Se outro processo pegar o arquivo (um backup, um sqlite3 aberto à mão),
  // esperar é melhor que falhar na cara do atendimento.
  banco.exec("PRAGMA busy_timeout = 5000");

  const versao = migrar(banco);
  console.log(`${LOG} banco aberto em ${caminho} (schema v${versao})`);

  return banco;
}

/**
 * Statements já compilados, por banco.
 *
 * `prepare()` não é barato: medido nesta base, compilar
 * `SELECT * FROM vinculos WHERE ticket_id = ?` custa 17,7 µs contra 10,2 µs
 * do `get()` em si — ou seja, 61% do tempo de uma leitura era recompilar o
 * mesmo SQL. E essa leitura acontece em TODA mensagem de TODO atendimento.
 *
 * `WeakMap` para o cache morrer junto com o banco (os testes abrem um por
 * caso), e `Map` por texto de SQL porque as consultas do plugin são um
 * conjunto fixo e pequeno — não há risco de crescer sem limite.
 *
 * O statement guarda o SQL compilado, não resultado: nada fica obsoleto. Em
 * mudança de schema o próprio SQLite recompila sozinho, e as migrações rodam
 * dentro do `abrirBanco`, antes de qualquer repositório existir.
 */
const statements = new WeakMap<Banco, Map<string, Statement>>();

export function preparado(banco: Banco, sql: string): Statement {
  let doBanco = statements.get(banco);
  if (!doBanco) {
    doBanco = new Map();
    statements.set(banco, doBanco);
  }
  let statement = doBanco.get(sql);
  if (!statement) {
    statement = banco.prepare(sql);
    doBanco.set(sql, statement);
  }
  return statement;
}

/** O que a aba Diagnóstico mostra sobre o próprio banco. */
export function estatisticas(banco: Banco): {
  caminho: string;
  versaoSchema: number;
  vinculos: number;
  abertos: number;
  eventos: number;
  tamanhoBytes: number;
} {
  const umNumero = (sql: string): number => Number(preparado(banco, sql).get()?.n ?? 0);

  return {
    // O caminho REALMENTE aberto, não o padrão: a aba Diagnóstico mostra isto,
    // e exibir um caminho que não é o em uso engana justamente quem está
    // tentando descobrir onde o banco foi parar.
    caminho: caminhoAberto.get(banco) || caminhoDoBanco(),
    versaoSchema: Number(preparado(banco, "PRAGMA user_version").get()?.user_version ?? 0),
    vinculos: umNumero("SELECT COUNT(*) AS n FROM vinculos"),
    abertos: umNumero("SELECT COUNT(*) AS n FROM vinculos WHERE finalizado = 0"),
    eventos: umNumero("SELECT COUNT(*) AS n FROM eventos"),
    // page_count * page_size é o tamanho real do arquivo principal (sem o WAL),
    // e sai do próprio banco — sem depender de `fs` nem do caminho resolver.
    tamanhoBytes:
      umNumero("SELECT page_count AS n FROM pragma_page_count()") *
      umNumero("SELECT page_size AS n FROM pragma_page_size()")
  };
}
