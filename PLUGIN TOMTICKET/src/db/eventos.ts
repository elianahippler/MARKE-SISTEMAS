import { preparado, type Banco } from "@/db/banco";

/**
 * O repositório do diagnóstico — as linhas de log do plugin.
 *
 * O que muda em relação ao array no PluginStorage:
 *
 * - **Append-only.** Era um array de 200 reescrito INTEIRO a cada rajada de
 *   log; agora cada linha é um INSERT. Some a espera de 5 s que existia só
 *   para agrupar regravações.
 * - **O teto cresce.** 200 eventos cabiam num dia calmo; a poda agora é por
 *   quantidade E por idade, com folga para achar o que aconteceu ontem.
 * - **O filtro é do servidor.** A aba filtrava em memória o que tinha baixado,
 *   então "erros e avisos (3)" contava 3 entre os 200 que vieram — não entre
 *   os que existem. Agora a contagem vem de `COUNT(*)` e o filtro, de `WHERE`.
 */

export type Nivel = "erro" | "aviso" | "info";

export interface Evento {
  quando: string;
  nivel: Nivel;
  texto: string;
}

export type Filtro = "problemas" | "chamados" | "tudo";

/**
 * Quantos eventos manter.
 *
 * 5000 em vez dos 200 de antes porque o custo mudou de natureza: no array, o
 * teto limitava o tamanho de uma gravação que acontecia a cada rajada; aqui é
 * só o ponto em que a poda começa a apagar. 5000 linhas de log são da ordem de
 * 1 MB — irrelevante no volume, e o bastante para cobrir o fim de semana.
 */
const MAXIMO = 5_000;

/** Idade máxima de um evento. Log de duas semanas atrás não diagnostica nada. */
const DIAS_DE_RETENCAO = 14;

/**
 * A cada quantos registros a poda roda.
 *
 * Não a cada linha: a poda é um DELETE com subconsulta, e rodá-la em todo log
 * gastaria mais que o próprio log. Não num temporizador, tampouco — seria um
 * `setInterval` vivo num processo que passa a maior parte do tempo sem logar.
 */
const PODAR_A_CADA = 200;

/**
 * Como se reconhece uma linha "de chamado".
 *
 * Decidido na GRAVAÇÃO e guardado em coluna. A tela usava a expressão regular
 * `/→ chamado|finalizado pelo ticket/` sobre o texto; repeti-la em SQL
 * deixaria duas verdades para a mesma pergunta, e a terceira frase de chamado
 * que alguém escrevesse num log entraria numa e não na outra.
 */
const MARCAS_DE_CHAMADO = ["→ chamado", "finalizado pelo ticket"];

export function ehDeChamado(texto: string): boolean {
  return MARCAS_DE_CHAMADO.some(marca => texto.includes(marca));
}

export class RepositorioEventos {
  private desdeAPoda = 0;

  constructor(private readonly banco: Banco) {}

  /** Registra uma linha de log. */
  registrar(evento: Evento): void {
    preparado(this.banco, "INSERT INTO eventos (quando, nivel, texto, eh_chamado) VALUES (?, ?, ?, ?)")
      .run(evento.quando, evento.nivel, evento.texto, ehDeChamado(evento.texto) ? 1 : 0);

    if (++this.desdeAPoda >= PODAR_A_CADA) {
      this.desdeAPoda = 0;
      this.podar();
    }
  }

  /** Vários de uma vez — é por aqui que entra o que foi importado do storage. */
  registrarVarios(eventos: Evento[]): void {
    if (!eventos.length) return;
    this.banco.exec("BEGIN");
    try {
      for (const evento of eventos) this.registrar(evento);
      this.banco.exec("COMMIT");
    } catch (err) {
      this.banco.exec("ROLLBACK");
      throw err;
    }
  }

  /** A contagem de cada aba, sobre a tabela inteira. */
  contagens(): { problemas: number; chamados: number; tudo: number } {
    const n = (sql: string) => Number(preparado(this.banco, sql).get()?.n ?? 0);
    return {
      problemas: n("SELECT COUNT(*) AS n FROM eventos WHERE nivel <> 'info'"),
      chamados: n("SELECT COUNT(*) AS n FROM eventos WHERE eh_chamado = 1"),
      tudo: n("SELECT COUNT(*) AS n FROM eventos")
    };
  }

  /** Os eventos de uma aba, mais recentes primeiro. */
  listar(filtro: Filtro = "problemas", limite = 300): Evento[] {
    const onde =
      filtro === "problemas"
        ? "WHERE nivel <> 'info'"
        : filtro === "chamados"
          ? "WHERE eh_chamado = 1"
          : "";

    const teto = Math.min(Math.max(Number(limite) || 300, 1), 1000);

    return preparado(this.banco, `SELECT quando, nivel, texto FROM eventos ${onde} ORDER BY id DESC LIMIT ?`)
      .all(teto)
      .map(linha => ({
        quando: String(linha.quando),
        nivel: String(linha.nivel) as Nivel,
        texto: String(linha.texto)
      }));
  }

  /**
   * Apaga o que passou do teto ou da idade.
   *
   * Por idade E por quantidade: só por idade, um dia de muitos erros encheria
   * o arquivo; só por quantidade, um plugin parado guardaria para sempre o log
   * de meses atrás.
   */
  podar(): number {
    const corte = new Date(Date.now() - DIAS_DE_RETENCAO * 86_400_000).toISOString();

    const porIdade = preparado(this.banco, "DELETE FROM eventos WHERE quando < ?").run(corte);
    const porQuantidade = preparado(this.banco, 
        `DELETE FROM eventos WHERE id NOT IN (
           SELECT id FROM eventos ORDER BY id DESC LIMIT ?
         )`
      )
      .run(MAXIMO);

    return Number(porIdade.changes) + Number(porQuantidade.changes);
  }
}
