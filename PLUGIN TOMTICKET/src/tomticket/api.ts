/**
 * Cliente da API REST do TomTicket (v2.0).
 *
 * Endpoints verificados contra a API de produção em 29/09/2026. Dois detalhes
 * que não são óbvios pela documentação:
 *
 * - O `ticket_id` é um hash, NÃO o número de protocolo que o cliente conhece.
 *   Quem tem o protocolo em mãos precisa resolver antes (`buscarPorProtocolo`).
 * - As escritas são `multipart/form-data`, não JSON — enviar JSON devolve 401
 *   sem dizer o motivo.
 */

const API_BASE = "https://api.tomticket.com/v2.0";

export interface RespostaTomTicket<T = any> {
  error: boolean;
  message: string;
  success: boolean;
  size?: number;
  pages?: number;
  next_page?: number | null;
  previous_page?: number | null;
  data?: T;
  /** `POST /ticket/new` devolve isto na raiz — não em `data`, apesar do resto da API usar `data`. */
  ticket_id?: string;
  protocol?: number;
}

/**
 * Arquivo enviado junto de um chamado ou resposta.
 *
 * A API recebe como `attachment[0]`, `attachment[1]`... (confirmado ao vivo em
 * 01/10/2026 — imagem e áudio chegaram no chamado). Limite dela: 25 MB somando
 * a requisição inteira, 25 arquivos.
 */
export interface Anexo {
  nome: string;
  dados: Blob;
}

export class ErroTomTicket extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ErroTomTicket";
  }
}

export class TomTicketApi {
  constructor(private readonly token: string) {}

  private async chamar<T>(
    metodo: "GET" | "POST",
    caminho: string,
    opcoes: { query?: Record<string, any>; form?: Record<string, any>; anexos?: Anexo[] } = {},
    tentativa = 1
  ): Promise<RespostaTomTicket<T>> {
    let url = `${API_BASE}${caminho}`;

    if (opcoes.query) {
      const qs = new URLSearchParams();
      for (const [chave, valor] of Object.entries(opcoes.query)) {
        if (valor === undefined || valor === null || valor === "") continue;
        qs.set(chave, String(valor));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const init: RequestInit = {
      method: metodo,
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(20_000)
    };

    if (opcoes.form) {
      const fd = new FormData();
      for (const [chave, valor] of Object.entries(opcoes.form)) {
        if (valor === undefined || valor === null || valor === "") continue;
        fd.append(chave, String(valor));
      }
      (opcoes.anexos || []).forEach((anexo, i) => fd.append(`attachment[${i}]`, anexo.dados, anexo.nome));
      init.body = fd;
    }

    const res = await fetch(url, init);

    // 429 devolve uma página HTML do nginx, não JSON — e nem tenta parsear
    // vale a pena, porque a resposta certa é esperar e tentar de novo. Um
    // atendimento real pode disparar várias chamadas (criar, vincular,
    // transferir, responder) em sequência rápida; sem isto, uma rajada normal
    // vira erro definitivo no meio do fluxo.
    if (res.status === 429 && tentativa <= 3) {
      await res.text();
      await new Promise(r => setTimeout(r, 1000 * tentativa));
      return this.chamar<T>(metodo, caminho, opcoes, tentativa + 1);
    }

    const texto = await res.text();

    let corpo: RespostaTomTicket<T>;
    try {
      corpo = texto ? JSON.parse(texto) : ({} as RespostaTomTicket<T>);
    } catch {
      throw new ErroTomTicket(`resposta não-JSON do TomTicket: ${texto.slice(0, 200)}`, res.status);
    }

    // O TomTicket devolve 200 com `error: true` em parte dos casos, então
    // checar só o status HTTP deixaria falha passar como sucesso.
    if (!res.ok || corpo.error) {
      throw new ErroTomTicket(corpo.message || `HTTP ${res.status}`, res.status);
    }

    return corpo;
  }

  listarChamados(filtros: Record<string, any> = {}) {
    return this.chamar<any[]>("GET", "/ticket/list", { query: filtros });
  }

  detalharChamado(ticketId: string, extras: Record<string, any> = {}) {
    return this.chamar<any>("GET", "/ticket/detail", {
      query: { ticket_id: ticketId, ...extras }
    });
  }

  /**
   * Resolve o hash do chamado a partir do número de protocolo.
   *
   * A API não tem busca por protocolo exato — só a faixa `min`/`max`, que com
   * os dois iguais devolve o chamado único.
   */
  async buscarPorProtocolo(protocolo: number | string) {
    const res = await this.listarChamados({
      min_protocol: protocolo,
      max_protocol: protocolo
    });
    return res.data?.[0] || null;
  }

  criarChamado(dados: {
    customer_id: string;
    department_id: string;
    subject: string;
    message: string;
    customer_id_type?: "I" | "E";
    category_id?: string;
    priority?: number;
    /** Campos personalizados por id: `{ "<idDoCampo>": "valor" }`. */
    custom_field?: Record<string, string>;
    anexos?: Anexo[];
  }) {
    const { custom_field, anexos, ...resto } = dados;
    const form: Record<string, any> = { ...resto };

    // form-data não tem objeto aninhado: a API espera cada campo como
    // `custom_field[<id>]`. Mandar o objeto serializado grava a string "[object
    // Object]" no chamado, sem erro nenhum.
    for (const [id, valor] of Object.entries(custom_field || {})) {
      form[`custom_field[${id}]`] = valor;
    }

    return this.chamar<any>("POST", "/ticket/new", { form, anexos });
  }

  /**
   * Campos personalizados de chamado da conta, sem repetir.
   *
   * Vêm aninhados por categoria (e nos gerais do setor), e o mesmo campo
   * aparece em dezenas delas — daí a deduplicação por id.
   */
  async listarCamposPersonalizados(): Promise<Array<{ id: string; label: string }>> {
    const res = await this.listarDepartamentos(true);
    const porId = new Map<string, { id: string; label: string }>();

    const registrar = (campos: any[]) => {
      for (const campo of campos || []) {
        if (campo?.id && !porId.has(campo.id)) {
          porId.set(campo.id, { id: campo.id, label: campo.label });
        }
      }
    };

    for (const departamento of res.data || []) {
      registrar(departamento.general_custom_fields?.tickets);
      for (const categoria of departamento.categories || []) registrar(categoria.custom_fields);
    }

    return [...porId.values()].sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  }

  /**
   * Cria o chamado e devolve id e protocolo.
   *
   * A documentação descreve a resposta como `{ error, message, success }` —
   * sem id. Na prática (confirmado ao vivo em 30/09/2026) ela traz
   * `ticket_id` e `protocol` na RAIZ da resposta, não em `data`. Usar os dois
   * direto evita uma segunda chamada e, mais importante, evita uma corrida:
   * `GET /ticket/list` logo após o `POST /ticket/new` pode não encontrar o
   * chamado recém-criado (visto na prática: 200 OK com lista vazia,
   * reaparecendo numa tentativa seguinte) — indexação com atraso, não erro.
   * O fallback por lista fica só para o caso de a API parar de devolver os
   * campos diretos.
   */
  async criarChamadoEObterId(
    dados: Parameters<TomTicketApi["criarChamado"]>[0]
  ): Promise<{ id: string; protocolo?: string } | null> {
    const resposta = await this.criarChamado(dados);
    const idDireto = resposta?.ticket_id || resposta?.data?.id || (resposta as any)?.id;

    if (idDireto) {
      return { id: String(idDireto), protocolo: resposta?.protocol ? String(resposta.protocol) : undefined };
    }

    // Fallback: a resposta não trouxe o id. Tenta algumas vezes por causa do
    // atraso de indexação observado — sem retry, a primeira tentativa vazia
    // perde o chamado (ele existe, só não apareceu na lista ainda).
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const recentes = await this.listarChamados({
        customer_id: dados.customer_id,
        customer_type_id: dados.customer_id_type || "I",
        order: "DESC",
        column: "protocol"
      });
      const maisRecente = recentes.data?.[0];
      if (maisRecente?.id) {
        return { id: String(maisRecente.id), protocolo: String(maisRecente.protocol) };
      }
      if (tentativa < 3) await new Promise(r => setTimeout(r, 1000 * tentativa));
    }

    return null;
  }

  /**
   * Resposta em nome do atendente VINCULADO ao chamado — a API não tem como
   * escolher outro autor.
   *
   * Sem nenhum atendente vinculado, a resposta é gravada como do CLIENTE
   * (`sender_type: "C"`), sem erro nenhum — confirmado ao vivo em 01/10/2026.
   * Era isso que fazia as mensagens do bot aparecerem como do cliente: elas
   * saem antes de alguém aceitar o atendimento. Quem chama precisa garantir o
   * atendente certo vinculado antes.
   */
  responderComoAtendente(ticketId: string, mensagem: string, anexos?: Anexo[]) {
    return this.chamar("POST", "/ticket/reply/operator", {
      form: { ticket_id: ticketId, message: mensagem },
      anexos
    });
  }

  /** Resposta em nome do cliente DO CHAMADO — a API não aceita outro cliente. */
  responderComoCliente(ticketId: string, mensagem: string, anexos?: Anexo[]) {
    return this.chamar("POST", "/ticket/reply/customer", {
      form: { ticket_id: ticketId, message: mensagem },
      anexos
    });
  }

  /**
   * Move o chamado de setor.
   *
   * SÓ `department_id`. A documentação descreve `operator_id` como aceito
   * aqui também, mas confirmado ao vivo em 30/09/2026 que ele SEMPRE falha
   * nesta conta — "not possible to transfer tickets without attendants",
   * mesmo repetindo o atendente já vinculado ao chamado. Também confirmado:
   * a API recusa QUALQUER transferência (só `department_id`) de um chamado
   * sem nenhum atendente vinculado ainda. Para trocar o atendente, use
   * `vincularAtendente` (`/ticket/operator/link`).
   */
  transferirChamado(ticketId: string, destino: { departamentoId: string }) {
    return this.chamar("POST", "/ticket/transfer", {
      form: {
        ticket_id: ticketId,
        department_id: destino.departamentoId
      }
    });
  }

  vincularAtendente(ticketId: string, operadorId: string) {
    return this.chamar("POST", "/ticket/operator/link", {
      form: { ticket_id: ticketId, operator_id: operadorId }
    });
  }

  comentarChamado(ticketId: string, comentario: string) {
    return this.chamar("POST", "/ticket/comment", {
      form: { ticket_id: ticketId, comment: comentario }
    });
  }

  finalizarChamado(ticketId: string, mensagem: string, tempoMinutos?: number) {
    return this.chamar("POST", "/ticket/finish", {
      form: { ticket_id: ticketId, message: mensagem, time_work: tempoMinutos }
    });
  }

  listarClientes(filtros: Record<string, any> = {}) {
    return this.chamar<any[]>("GET", "/customer/list", { query: filtros });
  }

  criarCliente(dados: {
    customer_id: string;
    name: string;
    email?: string;
    phone?: string;
    organization_id?: string;
  }) {
    return this.chamar("POST", "/customer/new", { form: dados });
  }

  listarDepartamentos(comItensAninhados = false) {
    return this.chamar<any[]>("GET", "/department/list", {
      query: { show_nested_items: comItensAninhados ? 1 : 0 }
    });
  }

  /**
   * Todos os atendentes da conta, sem repetir.
   *
   * A API não tem listagem global de atendentes — só a de cada departamento.
   * Como o mesmo atendente costuma estar em vários, juntar sem deduplicar
   * traria o nome repetido no seletor.
   */
  async listarAtendentes(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.listarDepartamentos(true);
    const porId = new Map<string, { id: string; name: string }>();

    for (const departamento of res.data || []) {
      for (const atendente of departamento.operators || []) {
        if (atendente?.id && !porId.has(atendente.id)) {
          porId.set(atendente.id, { id: atendente.id, name: atendente.name });
        }
      }
    }

    return [...porId.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

}
