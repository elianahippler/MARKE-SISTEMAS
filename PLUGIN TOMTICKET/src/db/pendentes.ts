import { preparado, type Banco } from "@/db/banco";

/**
 * As respostas do atendente esperando o WhatsApp confirmar o envio.
 *
 * Ver `src/ack.ts` para o porquê da espera. Aqui mora só o armazenamento: quem
 * decide quando espelhar é o fluxo.
 */

/** Uma resposta na fila, com o payload do hook que a originou. */
export interface Pendente {
  mensagemId: string;
  ticketId: string;
  quando: string;
  /** O ack já confirmou o envio desta. */
  confirmada: boolean;
  /** O payload do hook `ticket:messageSent`, como veio. */
  dados: any;
}

function daLinha(linha: any): Pendente | null {
  try {
    return {
      mensagemId: String(linha.mensagem_id),
      ticketId: String(linha.ticket_id),
      quando: String(linha.quando),
      confirmada: !!linha.confirmada,
      dados: JSON.parse(String(linha.dados))
    };
  } catch {
    // JSON quebrado é linha inútil: quem lê não tem o que espelhar. Devolver
    // null deixa o chamador descartá-la, em vez de derrubar a fila inteira do
    // ticket por causa de uma linha.
    return null;
  }
}

export class RepositorioPendentes {
  constructor(private readonly banco: Banco) {}

  /**
   * Põe a resposta na fila.
   *
   * `INSERT OR REPLACE`: o mesmo evento pode chegar duas vezes (reconexão do
   * canal, reenvio do backend). Duas linhas virariam duas respostas no
   * chamado — o cliente lendo a mesma coisa em dobro.
   */
  enfileirar(mensagemId: string | number, ticketId: string | number, dados: unknown): void {
    preparado(
      this.banco,
      "INSERT OR REPLACE INTO pendentes (mensagem_id, ticket_id, quando, dados) VALUES (?, ?, ?, ?)"
    ).run(String(mensagemId), String(ticketId), new Date().toISOString(), JSON.stringify(dados));
  }

  ler(mensagemId: string | number): Pendente | null {
    const linha = preparado(this.banco, "SELECT * FROM pendentes WHERE mensagem_id = ?").get(String(mensagemId));
    return linha ? daLinha(linha) : null;
  }

  /**
   * A fila do ticket, da mais antiga para a mais nova.
   *
   * A ordem é o ponto: o chamado é uma conversa. Se a segunda resposta tiver o
   * ack antes da primeira — e isso acontece, o WhatsApp confirma fora de ordem
   * —, espelhar na ordem da confirmação inverteria as frases no chamado.
   */
  doTicket(ticketId: string | number): Pendente[] {
    return preparado(this.banco, "SELECT * FROM pendentes WHERE ticket_id = ? ORDER BY quando, rowid")
      .all(String(ticketId))
      .map(daLinha)
      .filter((p): p is Pendente => p !== null);
  }

  /**
   * O WhatsApp confirmou o envio desta.
   *
   * Marca em vez de espelhar na hora: a resposta só vai ao chamado quando as
   * anteriores do mesmo ticket também tiverem saído, senão as frases trocam de
   * ordem na leitura. Ver `doTicket`.
   */
  confirmar(mensagemId: string | number): void {
    preparado(this.banco, "UPDATE pendentes SET confirmada = 1 WHERE mensagem_id = ?").run(String(mensagemId));
  }

  remover(mensagemId: string | number): void {
    preparado(this.banco, "DELETE FROM pendentes WHERE mensagem_id = ?").run(String(mensagemId));
  }

  /** As que passaram do tempo de espera — o WhatsApp nunca confirmou. */
  expiradas(limiteMs: number): Pendente[] {
    const corte = new Date(Date.now() - limiteMs).toISOString();
    return preparado(this.banco, "SELECT * FROM pendentes WHERE quando < ? ORDER BY quando")
      .all(corte)
      .map(daLinha)
      .filter((p): p is Pendente => p !== null);
  }

  quantas(): number {
    return Number(preparado(this.banco, "SELECT COUNT(*) AS n FROM pendentes").get()?.n ?? 0);
  }
}
