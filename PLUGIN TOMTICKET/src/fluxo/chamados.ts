/**
 * O atendimento do Markedesk espelhado como chamado no TomTicket.
 *
 * Ciclo: o ticket nasce, mas o chamado só é aberto na PRIMEIRA MENSAGEM depois
 * disso (enviada ou recebida) — ticket criado sem nenhuma mensagem nunca vira
 * chamado. É essa mensagem que entra como conteúdo inicial. Dali em diante:
 * entra numa fila → o chamado é transferido para o setor dela; é aceito → o
 * chamado ganha o atendente correspondente; as mensagens seguintes viram
 * respostas no chamado.
 *
 * Toda operação é best-effort: uma falha aqui não pode atrapalhar o
 * atendimento em si, então erra para o log e segue.
 */
import type { PluginServer } from "@markedesk/plugin-sdk";
import { LOG } from "@/identidade";
import { TomTicketApi } from "@/tomticket/api";
import {
  clienteTomTicket,
  lerDaMemoria,
  lerConfiguracao,
  operadorDoUsuario,
  destinoDaFila,
  type ConfiguracaoTomTicket
} from "@/config/settings";

/** O que guardamos sobre o chamado de um ticket. */
interface VinculoChamado {
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
   * `department_id`, em chamado recém-criado. Como a fila normalmente é
   * atribuída pelo chatbot ANTES de um atendente aceitar, a primeira
   * transferência quase sempre cai nesse caso. Guardamos o destino aqui e
   * completamos a mudança quando `aoAtribuir` finalmente vincular alguém.
   */
  departamentoPendente?: string;
  /** Email com que o cliente foi identificado no TomTicket. */
  clienteEmail: string;
}

/**
 * Limite de caracteres da mensagem no TomTicket.
 *
 * A API recusa acima disso. Cortar é melhor que perder a mensagem inteira — e
 * a reticência avisa quem lê que há mais no Markedesk.
 */
const LIMITE_MENSAGEM = 512;

function encurtar(texto: string): string {
  if (texto.length <= LIMITE_MENSAGEM) return texto;
  return `${texto.slice(0, LIMITE_MENSAGEM - 3)}...`;
}

/**
 * O texto que representa a mensagem no chamado.
 *
 * Mídia sem legenda chega com `body` vazio: sem isto a chamada falharia por
 * `message` obrigatório, e o chamado ficaria sem o registro de que algo foi
 * enviado.
 */
function corpoDaMensagem(mensagem: any): string {
  const corpo = String(mensagem?.body || "").trim();
  if (corpo) return encurtar(corpo);

  const tipo = mensagem?.mediaType;
  if (tipo && tipo !== "chat") return `[${tipo}]`;
  return "[mensagem sem texto]";
}

function chaveDoVinculo(ticketId: number | string): string {
  return `ticket:${ticketId}`;
}

export class FluxoChamados {
  /**
   * Cache dos vínculos, à frente do PluginStorage.
   *
   * O storage é a persistência (sobrevive a restart), mas ele vive no backend:
   * uma indisponibilidade dele órfãos todas as mensagens seguintes de um
   * atendimento em curso, porque não se acharia mais o chamado. Além disso cada
   * mensagem faria uma ida ao backend só para descobrir um id que não muda.
   */
  private readonly cache = new Map<string, VinculoChamado>();

  constructor(private readonly server: PluginServer) {}

  private async config(companyId?: number): Promise<ConfiguracaoTomTicket> {
    return lerDaMemoria(companyId) || (await lerConfiguracao(this.server));
  }

  private async api(companyId?: number): Promise<TomTicketApi | null> {
    return clienteTomTicket(this.server, companyId);
  }

  private async lerVinculo(ticketId: number | string): Promise<VinculoChamado | null> {
    const chave = chaveDoVinculo(ticketId);
    const emCache = this.cache.get(chave);
    if (emCache) return emCache;

    try {
      const doStorage = await this.server.client?.storage.get<VinculoChamado>(chave);
      if (doStorage) this.cache.set(chave, doStorage);
      return doStorage || null;
    } catch {
      return null;
    }
  }

  private async gravarVinculo(
    ticketId: number | string,
    vinculo: VinculoChamado
  ): Promise<void> {
    const chave = chaveDoVinculo(ticketId);
    this.cache.set(chave, vinculo);

    try {
      await this.server.client?.storage.set(chave, vinculo);
    } catch (err: any) {
      // Sem o vínculo gravado o chamado existe mas fica órfão: as mensagens
      // seguintes não sabem onde entrar. Vale um log alto.
      // O cache acima segura o atendimento em curso; o que se perde é o
      // vínculo depois de um restart do plugin.
      console.error(
        `${LOG} vínculo do ticket ${ticketId} não foi persistido (segue em memória): ${err?.message || err}`
      );
    }
  }

  /**
   * Abre um chamado para o ticket e guarda o vínculo.
   *
   * Devolve `null` quando não dá para abrir — sem email do contato, sem setor
   * configurado ou com o cliente ausente no TomTicket. São situações de
   * configuração, não de erro passageiro, então avisam no log e param ali.
   */
  private async abrirChamado(
    api: TomTicketApi,
    config: ConfiguracaoTomTicket,
    ticket: any,
    destino: { departamentoId: string; categoriaId?: string },
    mensagemInicial: string
  ): Promise<VinculoChamado | null> {
    const email = String(ticket?.contact?.email || "").trim();
    if (!email) {
      console.warn(
        `${LOG} ticket ${ticket?.id} sem email no contato — chamado não criado (o cliente é identificado pelo email).`
      );
      return null;
    }

    const assunto = `Atendimento ${ticket?.channel || "Markedesk"} - ${ticket?.contact?.name || email}`;

    try {
      const criado = await api.criarChamadoEObterId({
        customer_id: email,
        customer_id_type: "E",
        department_id: destino.departamentoId,
        category_id: destino.categoriaId,
        subject: assunto,
        message: encurtar(mensagemInicial),
        // O id do ticket gravado no chamado é o que permite achar um a partir
        // do outro fora do plugin — no TomTicket e no fluxo do n8n.
        custom_field: config.campoProtocoloId
          ? { [config.campoProtocoloId]: String(ticket.id) }
          : undefined
      });

      if (!criado) {
        console.error(`${LOG} chamado do ticket ${ticket?.id} criado mas o id não pôde ser obtido.`);
        return null;
      }

      const vinculo: VinculoChamado = {
        chamadoId: criado.id,
        protocolo: criado.protocolo,
        departamentoId: destino.departamentoId,
        clienteEmail: email
      };
      await this.gravarVinculo(ticket.id, vinculo);
      console.log(
        `${LOG} ticket ${ticket.id} → chamado ${criado.id}${criado.protocolo ? ` (protocolo ${criado.protocolo})` : ""}`
      );

      await this.registrarNoBanco(config, ticket, vinculo, destino, mensagemInicial);
      return vinculo;
    } catch (err: any) {
      console.error(`${LOG} falha ao criar chamado do ticket ${ticket?.id}: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Grava o vínculo na tabela `comunica`, pelo webhook do n8n.
   *
   * O plugin já guarda o vínculo no PluginStorage para o próprio uso; o banco
   * existe para o que está FORA dele — fluxos do n8n e relatórios que precisam
   * ligar um ticket a um chamado. Por isso a falha aqui não interrompe nada:
   * o atendimento e o chamado já estão de pé.
   */
  private async registrarNoBanco(
    config: ConfiguracaoTomTicket,
    ticket: any,
    vinculo: VinculoChamado,
    destino: { departamentoId: string; categoriaId?: string },
    mensagem: string
  ): Promise<void> {
    if (!config.webhookVinculo) return;

    try {
      const res = await fetch(config.webhookVinculo, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markedesk: String(ticket.id),
          tomticket: vinculo.chamadoId,
          // `null`, e não "": a coluna ID da tabela é numérica, e string vazia
          // faz o insert falhar em vez de gravar a linha sem protocolo.
          protocolo: vinculo.protocolo ? Number(vinculo.protocolo) : null,
          email: vinculo.clienteEmail,
          tipo: "E",
          departamento: destino.departamentoId,
          categoria: destino.categoriaId || "",
          mensagem: encurtar(mensagem),
          quem: ticket?.channel || "markedesk"
        }),
        signal: AbortSignal.timeout(10_000)
      });

      if (!res.ok) {
        console.error(`${LOG} webhook do vínculo respondeu HTTP ${res.status} (ticket ${ticket.id})`);
      }
    } catch (err: any) {
      console.error(`${LOG} falha ao gravar o vínculo no banco: ${err?.message || err}`);
    }
  }

  /**
   * O ticket mudou de fila.
   *
   * A primeira fila (o ticket saiu de "sem fila") apenas TRANSFERE o chamado
   * que já existe: é o mesmo atendimento chegando ao setor certo. Uma troca
   * posterior abre um chamado NOVO no setor de destino, porque aí o atendimento
   * anterior já aconteceu e o histórico dele pertence ao setor que atendeu.
   */
  async aoTransferir(dados: any): Promise<void> {
    const { ticket, oldQueueId, newQueueId, newUserId, companyId } = dados;
    if (!newQueueId) return;

    const config = await this.config(companyId);
    const api = await this.api(companyId);
    if (!api) return;

    const destino = destinoDaFila(config, newQueueId);
    if (!destino) {
      console.warn(`${LOG} fila ${newQueueId} não mapeada para nenhum setor — ticket ${ticket?.id}.`);
      return;
    }

    // Sem vínculo ainda: o chamado só nasce na primeira mensagem, não na fila.
    // Quando ela chegar, `aoMensagem` lê o `queueId` que o ticket já tem
    // (inclusive este) e abre direto no setor certo — nada a fazer aqui.
    const vinculo = await this.lerVinculo(ticket.id);
    if (!vinculo) return;

    const operadorId = newUserId ? operadorDoUsuario(config, newUserId) : undefined;

    // Primeira fila: o chamado só muda de lugar.
    if (!oldQueueId) {
      try {
        await this.transferirComAtendente(api, vinculo.chamadoId, destino.departamentoId, operadorId);
        await this.gravarVinculo(ticket.id, {
          ...vinculo,
          departamentoId: destino.departamentoId,
          departamentoPendente: undefined
        });
      } catch (err: any) {
        // Não conseguiu mover agora — provavelmente ainda sem atendente.
        // Guarda o destino; aoAtribuir tenta de novo quando alguém aceitar.
        console.warn(
          `${LOG} chamado ${vinculo.chamadoId} não pôde ser movido para o setor ${destino.departamentoId} agora (${err?.message || err}) — tentando de novo quando um atendente for vinculado.`
        );
        await this.gravarVinculo(ticket.id, { ...vinculo, departamentoPendente: destino.departamentoId });
      }
      return;
    }

    // Troca de setor depois de já ter sido atendido: chamado novo.
    const novo = await this.abrirChamado(
      api,
      config,
      ticket,
      destino,
      `Atendimento transferido de setor no Markedesk (chamado anterior: ${vinculo.chamadoId}).`
    );

    if (novo && operadorId) {
      await this.vincular(api, novo.chamadoId, operadorId);
    }
  }

  /** O ticket foi aceito: o chamado ganha o atendente correspondente. */
  async aoAtribuir(dados: any): Promise<void> {
    const { ticket, userId, companyId } = dados;
    if (!userId) return;

    const config = await this.config(companyId);
    const api = await this.api(companyId);
    if (!api) return;

    const operadorId = operadorDoUsuario(config, userId);
    if (!operadorId) {
      console.warn(`${LOG} atendente ${userId} não mapeado no TomTicket — ticket ${ticket?.id}.`);
      return;
    }

    const vinculo = await this.lerVinculo(ticket.id);
    if (!vinculo) return;

    await this.vincular(api, vinculo.chamadoId, operadorId);

    // Havia uma transferência de setor que não pôde acontecer por falta de
    // atendente (ver VinculoChamado.departamentoPendente) — agora que o
    // chamado tem um, tenta de novo.
    if (vinculo.departamentoPendente) {
      try {
        // `jaVinculado: true` — o vincular() logo acima já garantiu o
        // atendente; pedir de novo aqui só geraria o "does not allow adding
        // an operator" da API (TomTicket recusa religar o mesmo atendente em
        // sequência) sem mudar nada. O revincular DEPOIS da transferência
        // continua necessário — é ele quem limpa o atendente.
        await this.transferirComAtendente(api, vinculo.chamadoId, vinculo.departamentoPendente, operadorId, true);
        await this.gravarVinculo(ticket.id, {
          ...vinculo,
          departamentoId: vinculo.departamentoPendente,
          departamentoPendente: undefined
        });
      } catch (err: any) {
        console.error(
          `${LOG} chamado ${vinculo.chamadoId} continua sem poder ser movido para o setor ${vinculo.departamentoPendente}: ${err?.message || err}`
        );
      }
    }
  }

  private async vincular(api: TomTicketApi, chamadoId: string, operadorId: string): Promise<void> {
    try {
      await api.vincularAtendente(chamadoId, operadorId);
      console.log(`${LOG} chamado ${chamadoId} atribuído ao atendente ${operadorId}`);
    } catch (err: any) {
      console.error(`${LOG} falha ao vincular atendente no chamado ${chamadoId}: ${err?.message || err}`);
    }
  }

  /**
   * Muda o setor do chamado, preservando o atendente.
   *
   * Dois comportamentos do TomTicket, confirmados ao vivo em 30/09/2026, que
   * não estão na documentação:
   *
   * 1. `/ticket/transfer` recusa QUALQUER transferência de um chamado sem
   *    nenhum atendente vinculado ainda ("not possible to transfer tickets
   *    without attendants") — daí vincular ANTES, mesmo que `operadorId` já
   *    seja o atendente atual do chamado.
   * 2. Transferir LIMPA o atendente do chamado como efeito colateral, mesmo
   *    quando o setor de destino é diferente do atual — daí vincular de novo
   *    DEPOIS.
   *
   * Sem `operadorId` (fila atribuída antes de alguém aceitar, o caso comum),
   * o passo 1 não tem o que vincular e a chamada abaixo lança — é assim que o
   * chamador sabe que precisa marcar a transferência como pendente.
   *
   * `jaVinculado` pula o passo 1 quando quem chamou acabou de vincular esse
   * mesmo atendente e sabe que o precondition já está satisfeito — chamar
   * vincular de novo em seguida só provoca "does not allow adding an
   * operator" da API (ela recusa religar o mesmo atendente em sequência), sem
   * mudar nada. O passo 2 (revincular depois) continua sempre necessário.
   */
  private async transferirComAtendente(
    api: TomTicketApi,
    chamadoId: string,
    departamentoId: string,
    operadorId?: string,
    jaVinculado = false
  ): Promise<void> {
    if (operadorId && !jaVinculado) await this.vincular(api, chamadoId, operadorId);
    await api.transferirChamado(chamadoId, { departamentoId });
    console.log(`${LOG} chamado ${chamadoId} movido para o setor ${departamentoId}`);
    if (operadorId) await this.vincular(api, chamadoId, operadorId);
  }

  /**
   * Mensagem do atendimento vira conteúdo no chamado.
   *
   * Sem vínculo ainda, esta é a PRIMEIRA mensagem do atendimento — é ela que
   * abre o chamado (ticket criado sem nenhuma mensagem nunca vira chamado). O
   * texto dela já vai como conteúdo inicial; não é enviada de novo como
   * resposta depois.
   *
   * Com vínculo já existente, o lado importa: o que o cliente escreveu entra
   * como resposta DELE, e o que o atendente escreveu entra como resposta do
   * atendente — senão o chamado vira um monólogo e quem o ler depois não sabe
   * quem falou o quê.
   */
  async aoMensagem(dados: any, deQuem: "cliente" | "atendente"): Promise<void> {
    const { ticket, message, companyId } = dados;
    const config = await this.config(companyId);
    const api = await this.api(companyId);
    if (!api) return;

    const vinculo = await this.lerVinculo(ticket?.id);
    if (!vinculo) {
      await this.abrirNaPrimeiraMensagem(api, config, ticket, message);
      return;
    }

    const corpo = corpoDaMensagem(message);

    try {
      if (deQuem === "cliente") {
        await api.responderComoCliente(vinculo.chamadoId, corpo);
      } else {
        await api.responderComoAtendente(vinculo.chamadoId, corpo);
      }
    } catch (err: any) {
      console.error(
        `${LOG} falha ao registrar mensagem no chamado ${vinculo.chamadoId}: ${err?.message || err}`
      );
    }
  }

  /**
   * Abre o chamado a partir da primeira mensagem do atendimento.
   *
   * Se o ticket já tem fila/atendente NESTE momento (o evento de mensagem leva
   * o estado atual do ticket — ele pode ter chegado depois da fila ser
   * atribuída), abre direto no setor certo e já vincula o atendente, em vez de
   * nascer no setor inicial para `aoTransferir` corrigir depois.
   */
  private async abrirNaPrimeiraMensagem(
    api: TomTicketApi,
    config: ConfiguracaoTomTicket,
    ticket: any,
    message: any
  ): Promise<void> {
    const daFila = ticket?.queueId ? destinoDaFila(config, ticket.queueId) : null;
    const destino = daFila || (config.setorInicial ? { departamentoId: config.setorInicial, categoriaId: config.categoriaInicial } : null);

    if (!destino) {
      console.warn(
        `${LOG} ticket ${ticket?.id}: nem a fila atual nem o setor inicial estão configurados — chamado não criado.`
      );
      return;
    }

    const vinculo = await this.abrirChamado(api, config, ticket, destino, corpoDaMensagem(message));
    if (!vinculo) return;

    if (ticket?.userId) {
      const operadorId = operadorDoUsuario(config, ticket.userId);
      if (operadorId) await this.vincular(api, vinculo.chamadoId, operadorId);
    }
  }
}
