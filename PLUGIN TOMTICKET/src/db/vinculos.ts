import type { Banco } from "@/db/banco";
import type { MotivoDaFinalizacao } from "@/fluxo/finalizacao";

/**
 * O repositório dos vínculos ticket↔chamado.
 *
 * Toda a conversa com a tabela passa por aqui: o fluxo de chamados fala em
 * `VinculoChamado`, nunca em SQL. É o que permitiu trocar o PluginStorage por
 * SQLite mexendo em duas funções do fluxo (`lerVinculo` e `gravarVinculo`) em
 * vez de nas 839 linhas dele.
 *
 * Os métodos são SÍNCRONOS porque o `node:sqlite` é síncrono — ver o comentário
 * em `banco.ts`. Quem chama está em função `async` e não precisa mudar nada.
 */

/**
 * O que guardamos sobre o chamado de um ticket.
 *
 * Mora aqui, e não no fluxo, porque agora é o formato de uma TABELA: quem
 * define as colunas define o tipo, e assim uma coluna nova não pode nascer
 * sem o campo correspondente.
 *
 * `transcritos` saiu daqui de propósito — virou a tabela `transcricoes`, com
 * métodos próprios (`jaTranscrito` / `marcarTranscrito`). Como array ele era
 * lido junto do vínculo em TODA mensagem de TODO atendimento, só para ser
 * consultado quando chegasse um áudio.
 */
export interface VinculoChamado {
  chamadoId: string;
  /** Número que a pessoa vê e cita no TomTicket (o id é um hash). */
  protocolo?: string;
  /** Setor onde o chamado está DE FATO no TomTicket agora. */
  departamentoId?: string;
  /**
   * Setor para onde o chamado deveria ir, mas ainda não foi possível mover.
   *
   * Existe porque o TomTicket recusa transferir (mudar de setor) um chamado
   * sem atendente vinculado — confirmado ao vivo em 30/09/2026: falha com
   * "not possible to transfer tickets without attendants" mesmo só mudando
   * `department_id`, em chamado recém-criado. Com o atendente Bot configurado
   * o chamado já nasce com alguém vinculado e isto quase não acontece; sem
   * ele, guardamos o destino aqui e completamos a mudança quando `aoAtribuir`
   * finalmente vincular alguém.
   */
  departamentoPendente?: string;
  /**
   * Atendente vinculado ao chamado agora, até onde o plugin sabe.
   *
   * A resposta de atendente sai em nome de quem estiver vinculado — então
   * antes de cada uma o vínculo precisa ser o do autor (Bot ou a pessoa). Saber
   * quem já está poupa a troca (duas chamadas à API) quando o autor se repete.
   */
  operadorAtual?: string;
  /** Email com que o cliente foi identificado no TomTicket. */
  clienteEmail: string;
  /**
   * Fila do Markedesk de onde o chamado é, até onde o plugin sabe.
   *
   * Existe para a transferência não repetir o que já aconteceu: depois de uma
   * troca de fila, a mensagem automática da fila nova pode chegar ANTES do
   * evento de transferência e já abrir o chamado novo — o evento, ao chegar,
   * vê que o chamado já é desta fila e não abre outro.
   */
  filaId?: string;
  /**
   * O chamado foi finalizado — pelo botão "Finalizar Chamado" (junto com o
   * Resolver) ou pela transferência do atendimento.
   *
   * Depois disso o vínculo não recebe mais nada: responder num chamado
   * finalizado o reabriria.
   */
  finalizado?: boolean;
  /**
   * Por que foi finalizado. Decide quem abre o chamado seguinte: depois de
   * resolvido, só o cliente voltando a escrever (o que chega com o ticket
   * fechado — despedida, avaliação — pertence ao que acabou); depois de
   * transferido, qualquer mensagem, porque o atendimento continua.
   */
  finalizadoPor?: MotivoDaFinalizacao;
  /**
   * Categoria do chamado no TomTicket, quando o de-para da fila define uma.
   *
   * Guardada junto do `departamentoId` porque os dois são o destino escolhido
   * na abertura: sem ela, "para onde este chamado foi" responde só metade.
   */
  categoriaId?: string;
  /**
   * Começo da primeira mensagem do atendimento (ver `resumo`).
   *
   * É o que permite reconhecer um vínculo na listagem sem abrir o chamado no
   * TomTicket. Referência, não conteúdo: o histórico de verdade está lá.
   */
  mensagem?: string;
  /** Canal de onde o atendimento veio (`ticket.channel`): whatsapp, instagram... */
  canal?: string;
}

/** O vínculo com o que só o banco sabe: quando nasceu e quando mudou. */
export interface VinculoRegistrado extends VinculoChamado {
  ticketId: string;
  criadoEm: string;
  atualizadoEm: string;
}

/** Coluna vazia no SQLite é `null`; no objeto é `undefined`. */
function ouUndefined(valor: unknown): string | undefined {
  return valor == null || valor === "" ? undefined : String(valor);
}

function daLinha(linha: any): VinculoRegistrado {
  return {
    ticketId: String(linha.ticket_id),
    chamadoId: String(linha.chamado_id),
    protocolo: ouUndefined(linha.protocolo),
    departamentoId: ouUndefined(linha.departamento_id),
    departamentoPendente: ouUndefined(linha.departamento_pendente),
    operadorAtual: ouUndefined(linha.operador_atual),
    clienteEmail: String(linha.cliente_email ?? ""),
    filaId: ouUndefined(linha.fila_id),
    // SQLite não tem booleano: 0/1. Sem o `!!`, `finalizado` chegaria como
    // número e `if (vinculo.finalizado)` passaria a depender de 0 ser falsy —
    // o que funciona, mas vaza o tipo do banco para o resto do plugin.
    finalizado: !!linha.finalizado,
    finalizadoPor: ouUndefined(linha.finalizado_por) as MotivoDaFinalizacao | undefined,
    categoriaId: ouUndefined(linha.categoria_id),
    mensagem: ouUndefined(linha.mensagem),
    canal: ouUndefined(linha.canal),
    criadoEm: String(linha.criado_em),
    atualizadoEm: String(linha.atualizado_em)
  };
}

export class RepositorioVinculos {
  constructor(private readonly banco: Banco) {}

  /** O vínculo do ticket, ou `null` se ele nunca virou chamado. */
  ler(ticketId: number | string): VinculoRegistrado | null {
    const linha = this.banco
      .prepare("SELECT * FROM vinculos WHERE ticket_id = ?")
      .get(String(ticketId));
    return linha ? daLinha(linha) : null;
  }

  /**
   * Grava o vínculo — cria se não existe, atualiza se existe.
   *
   * `ON CONFLICT ... DO UPDATE` em vez de "ler, decidir, inserir ou atualizar":
   * o fluxo chama isto depois de cada mudança (transferência, atendente,
   * finalização) e um caminho só torna impossível a condição de corrida em que
   * dois eventos do mesmo ticket decidem "não existe" ao mesmo tempo.
   *
   * `criado_em` é preservado no update (`excluded` só alimenta as outras
   * colunas): é a data em que o chamado foi ABERTO, e sobrescrevê-la a cada
   * mensagem apagaria a única informação de quando o atendimento começou.
   */
  gravar(ticketId: number | string, vinculo: VinculoChamado): void {
    const agora = new Date().toISOString();

    this.banco
      .prepare(
        `INSERT INTO vinculos (
           ticket_id, chamado_id, protocolo, departamento_id, departamento_pendente,
           operador_atual, cliente_email, fila_id, finalizado, finalizado_por,
           categoria_id, mensagem, canal, criado_em, atualizado_em
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ticket_id) DO UPDATE SET
           chamado_id            = excluded.chamado_id,
           protocolo             = excluded.protocolo,
           departamento_id       = excluded.departamento_id,
           departamento_pendente = excluded.departamento_pendente,
           operador_atual        = excluded.operador_atual,
           cliente_email         = excluded.cliente_email,
           fila_id               = excluded.fila_id,
           finalizado            = excluded.finalizado,
           finalizado_por        = excluded.finalizado_por,
           categoria_id          = excluded.categoria_id,
           mensagem              = excluded.mensagem,
           canal                 = excluded.canal,
           atualizado_em         = excluded.atualizado_em`
      )
      .run(
        String(ticketId),
        vinculo.chamadoId,
        vinculo.protocolo ?? null,
        vinculo.departamentoId ?? null,
        vinculo.departamentoPendente ?? null,
        vinculo.operadorAtual ?? null,
        vinculo.clienteEmail ?? "",
        vinculo.filaId ?? null,
        vinculo.finalizado ? 1 : 0,
        vinculo.finalizadoPor ?? null,
        vinculo.categoriaId ?? null,
        vinculo.mensagem ?? null,
        vinculo.canal ?? null,
        agora,
        agora
      );
  }

  /**
   * Os vínculos mais recentes, com filtro opcional.
   *
   * É a consulta que o PluginStorage não permitia e que motivou o banco: dá
   * para ver o que o plugin abriu hoje, achar o ticket de um protocolo e
   * listar o que ficou com setor pendente — sem passar pelo n8n.
   */
  listar(
    filtro: { protocolo?: string; ticketId?: string; apenasAbertos?: boolean; limite?: number } = {}
  ): VinculoRegistrado[] {
    const condicoes: string[] = [];
    const params: unknown[] = [];

    if (filtro.protocolo) {
      condicoes.push("(protocolo = ? OR chamado_id = ?)");
      params.push(filtro.protocolo, filtro.protocolo);
    }
    if (filtro.ticketId) {
      condicoes.push("ticket_id = ?");
      params.push(filtro.ticketId);
    }
    if (filtro.apenasAbertos) condicoes.push("finalizado = 0");

    const onde = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";
    // Teto sempre presente: a tela não pode pedir a tabela inteira por
    // descuido e travar o navegador de quem abriu o Diagnóstico.
    const limite = Math.min(Math.max(Number(filtro.limite) || 50, 1), 500);

    return this.banco
      .prepare(`SELECT * FROM vinculos ${onde} ORDER BY criado_em DESC LIMIT ?`)
      .all(...params, limite)
      .map(daLinha);
  }

  /** Este áudio já foi transcrito neste chamado? */
  jaTranscrito(ticketId: number | string, wid: string): boolean {
    const linha = this.banco
      .prepare("SELECT 1 AS existe FROM transcricoes WHERE ticket_id = ? AND wid = ?")
      .get(String(ticketId), wid);
    return !!linha;
  }

  /**
   * Marca o áudio como transcrito.
   *
   * `INSERT OR IGNORE`: a chave primária (ticket, wid) é a garantia de não
   * repetir, então a corrida entre duas transcrições do mesmo áudio termina
   * sem erro em vez de num 'UNIQUE constraint failed' que o chamador teria de
   * tratar.
   */
  marcarTranscrito(ticketId: number | string, wid: string): void {
    this.banco
      .prepare("INSERT OR IGNORE INTO transcricoes (ticket_id, wid, quando) VALUES (?, ?, ?)")
      .run(String(ticketId), wid, new Date().toISOString());
  }
}
