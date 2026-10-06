/**
 * O atendimento do Markedesk espelhado como chamado no TomTicket.
 *
 * Ciclo: o ticket nasce, mas o chamado só é aberto na PRIMEIRA MENSAGEM depois
 * disso (enviada ou recebida) — ticket criado sem nenhuma mensagem nunca vira
 * chamado. Dali em diante: entra numa fila → o chamado é transferido para o
 * setor dela; é aceito → o chamado ganha o atendente correspondente; as
 * mensagens seguintes viram respostas no chamado, cada uma em nome de quem a
 * escreveu — cliente, atendente ou bot.
 *
 * Toda operação é best-effort: uma falha aqui não pode atrapalhar o
 * atendimento em si, então erra para o log e segue.
 */
import type { PluginServer } from "@markedesk/plugin-sdk";
import { LOG } from "@/identidade";
import { TomTicketApi, type Anexo } from "@/tomticket/api";
import {
  clienteTomTicket,
  lerDaMemoria,
  lerConfiguracao,
  operadorDoUsuario,
  destinoDaFila,
  type ConfiguracaoTomTicket
} from "@/config/settings";
import { autorDaMensagem, baixarAnexo, corpoDaMensagem, emPartes, resumo, type Autor } from "@/fluxo/mensagem";
import {
  assuntoDoChamado,
  extrairAssunto,
  minutosDesde,
  textoDaTranscricao,
  textoDeFinalizacao,
  transcricaoValida,
  type MotivoDaFinalizacao
} from "@/fluxo/finalizacao";
import { RepositorioVinculos, type VinculoChamado } from "@/db/vinculos";


/** Texto de abertura quando o atendimento começa pelo nosso lado. */
const ABERTURA_PELA_EMPRESA = "Atendimento iniciado pela empresa no Markedesk.";

/** Pedido de finalização do chamado de um ticket. */
interface DadosDaFinalizacao {
  ticketId: number | string;
  /** Quem finaliza (usuário do Markedesk) — o chamado sai no nome dele. */
  userId?: number | string | null;
  comResumo: boolean;
  resumo?: string | null;
  /** Padrão: "resolvido". */
  motivo?: MotivoDaFinalizacao;
}


export class FluxoChamados {

  /**
   * A última tarefa de cada ticket — os eventos de um ticket rodam em fila.
   *
   * Sem isto, a mensagem do cliente e a resposta do bot (que chegam quase
   * juntas) rodavam em paralelo: as duas viam "sem vínculo" e cada uma abria
   * um chamado; e mesmo com o chamado aberto, as respostas podiam entrar fora
   * de ordem, ou trocar o atendente vinculado no meio da outra.
   */
  private readonly filas = new Map<string, Promise<void>>();

  /**
   * O repositório é injetado, não criado aqui.
   *
   * Quem abre o banco é a instância do plugin (`tomticketInstance`), porque a
   * abertura é assíncrona e acontece uma vez no boot — um fluxo que abrisse o
   * seu próprio teria de lidar com "o banco já está pronto?" em cada método, e
   * o modo multi-tenant terminaria com dois handles para o mesmo arquivo.
   */
  constructor(
    private readonly server: PluginServer,
    private readonly vinculos: RepositorioVinculos
  ) {}

  private emSequencia(ticketId: number | string, tarefa: () => Promise<void>): Promise<void> {
    const chave = String(ticketId);
    const anterior = this.filas.get(chave) || Promise.resolve();
    const atual = anterior.then(tarefa).catch(err => {
      console.error(`${LOG} falha no ticket ${chave}: ${err?.message || err}`);
    });

    this.filas.set(chave, atual);
    // Ticket parado não pode segurar memória para sempre.
    atual.finally(() => {
      if (this.filas.get(chave) === atual) this.filas.delete(chave);
    });
    return atual;
  }

  private async config(companyId?: number): Promise<ConfiguracaoTomTicket> {
    return lerDaMemoria(companyId) || (await lerConfiguracao(this.server));
  }

  private async api(companyId?: number): Promise<TomTicketApi | null> {
    return clienteTomTicket(this.server, companyId);
  }

  /**
   * O vínculo do ticket, do banco do plugin.
   *
   * Sem cache em memória, e isso é uma SIMPLIFICAÇÃO que o banco permitiu: o
   * cache existia porque cada leitura era uma ida HTTP ao backend, e porque
   * uma indisponibilidade dele orfanava o atendimento em curso. Lendo de um
   * SQLite local as duas razões desaparecem — a consulta é por chave primária
   * em arquivo local, mais rápida que o `Map` depois de somar o custo de
   * manter os dois em sincronia.
   *
   * Continua `async` porque os ~15 pontos de chamada estão em funções `async`
   * e usam `await`; tirar a promessa aqui seria uma mudança de assinatura sem
   * ganho nenhum.
   */
  private async lerVinculo(ticketId: number | string): Promise<VinculoChamado | null> {
    try {
      return this.vinculos.ler(ticketId);
    } catch (err: any) {
      console.error(`${LOG} falha ao ler o vínculo do ticket ${ticketId}: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Grava o vínculo no banco do plugin.
   *
   * O erro aqui é alto porque a consequência é cara: sem o vínculo gravado o
   * chamado existe no TomTicket mas fica órfão, e a próxima mensagem do
   * atendimento abre um chamado NOVO — o cliente termina com dois protocolos
   * para o mesmo assunto.
   *
   * Antes, uma falha de gravação ainda deixava o atendimento em curso andar
   * pelo cache em memória, e o que se perdia era o vínculo depois de um
   * restart. Agora não há meio-caminho: se o SQLite local recusar a escrita,
   * é disco cheio ou arquivo corrompido — nenhum dos dois melhora com um
   * cache por cima, e seguir em memória esconderia o problema até o restart.
   */
  private async gravarVinculo(
    ticketId: number | string,
    vinculo: VinculoChamado
  ): Promise<void> {
    try {
      this.vinculos.gravar(ticketId, vinculo);
    } catch (err: any) {
      console.error(
        `${LOG} vínculo do ticket ${ticketId} NÃO foi gravado no banco — o chamado ` +
          `${vinculo.protocolo || vinculo.chamadoId} pode ficar órfão: ${err?.message || err}`
      );
    }
  }

  /**
   * Quem deve ficar vinculado ao chamado fora de uma resposta do bot: a
   * pessoa que aceitou o atendimento, ou o Bot enquanto ninguém aceitou.
   */
  private responsavel(config: ConfiguracaoTomTicket, userId?: number | string | null): string | undefined {
    return (userId ? operadorDoUsuario(config, userId) : undefined) || config.operadorBotId || undefined;
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
    mensagemInicial: string,
    anexo?: Anexo | null
  ): Promise<VinculoChamado | null> {
    const email = String(ticket?.contact?.email || "").trim();
    if (!email) {
      console.warn(
        `${LOG} ticket ${ticket?.id} sem email no contato — chamado não criado (o cliente é identificado pelo email).`
      );
      return null;
    }

    try {
      const criado = await api.criarChamadoEObterId({
        customer_id: email,
        customer_id_type: "E",
        department_id: destino.departamentoId,
        category_id: destino.categoriaId,
        subject: assuntoDoChamado(ticket.id),
        message: mensagemInicial,
        // O id do ticket gravado no chamado é o que permite achar um a partir
        // do outro fora do plugin — no TomTicket e no fluxo do n8n.
        custom_field: config.campoProtocoloId
          ? { [config.campoProtocoloId]: String(ticket.id) }
          : undefined,
        anexos: anexo ? [anexo] : undefined
      });

      if (!criado) {
        console.error(`${LOG} chamado do ticket ${ticket?.id} criado mas o id não pôde ser obtido.`);
        return null;
      }

      const vinculo: VinculoChamado = {
        chamadoId: criado.id,
        protocolo: criado.protocolo,
        departamentoId: destino.departamentoId,
        filaId: ticket?.queueId != null ? String(ticket.queueId) : undefined,
        clienteEmail: email,
        // Até a 0.2.0 estes três só iam para o n8n gravar na tabela `comunica`.
        // Com o webhook fora, são colunas do vínculo: o destino completo, uma
        // referência do assunto e o canal de origem.
        categoriaId: destino.categoriaId,
        mensagem: resumo(mensagemInicial),
        canal: ticket?.channel || "markedesk"
      };
      await this.gravarVinculo(ticket.id, vinculo);
      console.log(
        `${LOG} ticket ${ticket.id} → chamado ${criado.id}${criado.protocolo ? ` (protocolo ${criado.protocolo})` : ""}`
      );

      // Já nasce com alguém vinculado: é o que deixa o chamado ser transferido
      // de setor (a API recusa sem atendente) e o que faz a próxima resposta
      // do nosso lado sair com autor, e não como do cliente.
      const responsavel = this.responsavel(config, ticket?.userId);
      if (responsavel) await this.garantirAtendente(api, ticket.id, vinculo, responsavel);

      return vinculo;
    } catch (err: any) {
      console.error(`${LOG} falha ao criar chamado do ticket ${ticket?.id}: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * O ticket mudou de fila.
   *
   * A primeira fila (o ticket saiu de "sem fila", pelo menu do bot) apenas
   * TRANSFERE o chamado que já existe: é o mesmo atendimento chegando ao setor
   * certo. Uma troca posterior FINALIZA o chamado e abre um NOVO no setor de
   * destino: o atendimento anterior já aconteceu, e o histórico dele pertence
   * ao setor que atendeu.
   *
   * Quem transfere pela tela já chega aqui com o chamado finalizado — o botão
   * do plugin finaliza ANTES de a transferência sair, com o resumo da IA (que
   * precisa do login de quem clicou; ver BOTAO_FINALIZAR). Finalizar aqui é a
   * rede para o resto (fluxo, bot, API, tela sem o botão carregado): sai sem
   * resumo, mas o chamado não fica pendurado.
   */
  aoTransferir(dados: any): Promise<void> {
    return this.emSequencia(dados?.ticket?.id, () => this.transferir(dados));
  }

  private async transferir(dados: any): Promise<void> {
    const { ticket, oldQueueId, newQueueId, oldUserId, newUserId, companyId } = dados;
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

    // Uma mensagem da fila nova chegou antes deste evento e já abriu o
    // chamado dela (ver VinculoChamado.filaId).
    if (vinculo.filaId && vinculo.filaId === String(newQueueId)) return;

    const operadorId = this.responsavel(config, newUserId);
    const novoChamado = (anterior: VinculoChamado) =>
      this.abrirChamado(
        api,
        config,
        { ...ticket, queueId: newQueueId, userId: newUserId ?? ticket?.userId },
        destino,
        `Atendimento transferido de setor no Markedesk (chamado anterior: ${anterior.protocolo || anterior.chamadoId}).`
      );

    if (vinculo.finalizado) {
      // Finalizado pela tela, na hora de transferir: o atendimento segue no
      // setor novo. Finalizado por ter sido RESOLVIDO: não há o que continuar.
      if (vinculo.finalizadoPor === "transferencia" && ticket?.status !== "closed") await novoChamado(vinculo);
      return;
    }

    // Primeira fila: o chamado só muda de lugar.
    if (!oldQueueId) {
      try {
        await this.transferirComAtendente(api, ticket.id, vinculo, destino.departamentoId, operadorId);
        vinculo.departamentoId = destino.departamentoId;
        vinculo.departamentoPendente = undefined;
        vinculo.filaId = String(newQueueId);
        await this.gravarVinculo(ticket.id, vinculo);
      } catch (err: any) {
        // Não conseguiu mover agora — provavelmente ainda sem atendente.
        // Guarda o destino; aoAtribuir tenta de novo quando alguém aceitar.
        console.warn(
          `${LOG} chamado ${vinculo.chamadoId} não pôde ser movido para o setor ${destino.departamentoId} agora (${err?.message || err}) — tentando de novo quando um atendente for vinculado.`
        );
        vinculo.departamentoPendente = destino.departamentoId;
        await this.gravarVinculo(ticket.id, vinculo);
      }
      return;
    }

    // Troca de fila sem ter passado pela tela: finaliza aqui mesmo, sem
    // resumo, em nome de quem estava atendendo. Falhar não segura o chamado
    // novo — o atendimento já está no outro setor.
    try {
      await this.finalizarAgora({ ticketId: ticket.id, userId: oldUserId, comResumo: false, motivo: "transferencia" });
    } catch (err: any) {
      console.error(
        `${LOG} chamado ${vinculo.protocolo || vinculo.chamadoId} não pôde ser finalizado na transferência do ticket ${ticket.id}: ${err?.message || err}`
      );
    }

    // O abrirChamado já vincula o responsável.
    await novoChamado(vinculo);
  }

  /** O ticket foi aceito: o chamado ganha o atendente correspondente. */
  aoAtribuir(dados: any): Promise<void> {
    return this.emSequencia(dados?.ticket?.id, () => this.atribuir(dados));
  }

  private async atribuir(dados: any): Promise<void> {
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
    if (!vinculo || vinculo.finalizado) return;

    await this.garantirAtendente(api, ticket.id, vinculo, operadorId);

    // Havia uma transferência de setor que não pôde acontecer por falta de
    // atendente (ver VinculoChamado.departamentoPendente) — agora que o
    // chamado tem um, tenta de novo.
    if (vinculo.departamentoPendente) {
      try {
        await this.transferirComAtendente(api, ticket.id, vinculo, vinculo.departamentoPendente, operadorId);
        vinculo.departamentoId = vinculo.departamentoPendente;
        vinculo.departamentoPendente = undefined;
        await this.gravarVinculo(ticket.id, vinculo);
      } catch (err: any) {
        console.error(
          `${LOG} chamado ${vinculo.chamadoId} continua sem poder ser movido para o setor ${vinculo.departamentoPendente}: ${err?.message || err}`
        );
      }
    }
  }

  /**
   * Deixa `operadorId` vinculado ao chamado, se já não estiver. Devolve se
   * ele está vinculado ao final.
   *
   * "This ticket does not allow adding an operator" é a API recusando
   * vincular em chamado que JÁ TEM atendente — não dá para trocar direto, nem
   * para religar o mesmo. A saída, confirmada ao vivo em 01/10/2026: transferir
   * para o PRÓPRIO setor atual limpa o atendente sem mexer em setor, categoria
   * nem situação; aí o vínculo passa. É o que permite alternar Bot e pessoa no
   * mesmo chamado.
   */
  private async garantirAtendente(
    api: TomTicketApi,
    ticketId: number | string,
    vinculo: VinculoChamado,
    operadorId: string
  ): Promise<boolean> {
    if (vinculo.operadorAtual === operadorId) return true;

    try {
      await api.vincularAtendente(vinculo.chamadoId, operadorId);
    } catch (err: any) {
      const jaTemAtendente = /does not allow adding an operator/i.test(String(err?.message));
      if (!jaTemAtendente || !vinculo.departamentoId) {
        console.error(`${LOG} falha ao vincular atendente no chamado ${vinculo.chamadoId}: ${err?.message || err}`);
        return false;
      }

      try {
        await api.transferirChamado(vinculo.chamadoId, { departamentoId: vinculo.departamentoId });
        vinculo.operadorAtual = undefined;
        await api.vincularAtendente(vinculo.chamadoId, operadorId);
      } catch (err2: any) {
        console.error(`${LOG} falha ao trocar o atendente do chamado ${vinculo.chamadoId}: ${err2?.message || err2}`);
        await this.gravarVinculo(ticketId, vinculo);
        return false;
      }
    }

    console.log(`${LOG} chamado ${vinculo.chamadoId} atribuído ao atendente ${operadorId}`);
    vinculo.operadorAtual = operadorId;
    await this.gravarVinculo(ticketId, vinculo);
    return true;
  }

  /**
   * Muda o setor do chamado, preservando o atendente.
   *
   * Dois comportamentos do TomTicket, confirmados ao vivo em 30/09/2026, que
   * não estão na documentação:
   *
   * 1. `/ticket/transfer` recusa QUALQUER transferência de um chamado sem
   *    nenhum atendente vinculado ainda ("not possible to transfer tickets
   *    without attendants") — daí garantir alguém vinculado ANTES.
   * 2. Transferir LIMPA o atendente do chamado como efeito colateral, mesmo
   *    quando o setor de destino é diferente do atual — daí vincular de novo
   *    DEPOIS.
   *
   * Sem `operadorId` mantém quem já estava vinculado. Sem nenhum dos dois
   * (nem pessoa nem Bot configurado), a chamada abaixo lança — é assim que o
   * chamador sabe que precisa marcar a transferência como pendente.
   */
  private async transferirComAtendente(
    api: TomTicketApi,
    ticketId: number | string,
    vinculo: VinculoChamado,
    departamentoId: string,
    operadorId?: string
  ): Promise<void> {
    const quem = operadorId || vinculo.operadorAtual;
    if (quem) await this.garantirAtendente(api, ticketId, vinculo, quem);
    await api.transferirChamado(vinculo.chamadoId, { departamentoId });
    console.log(`${LOG} chamado ${vinculo.chamadoId} movido para o setor ${departamentoId}`);

    vinculo.operadorAtual = undefined;
    if (quem) await this.garantirAtendente(api, ticketId, vinculo, quem);
    else await this.gravarVinculo(ticketId, vinculo);
  }

  /**
   * Mensagem do atendimento vira conteúdo no chamado.
   *
   * Sem vínculo ainda, esta é a PRIMEIRA mensagem do atendimento — é ela que
   * abre o chamado (ticket criado sem nenhuma mensagem nunca vira chamado).
   * Se foi o cliente quem escreveu, o texto dela já vai como conteúdo inicial
   * (o conteúdo inicial é sempre atribuído ao cliente). Se foi o nosso lado, o
   * chamado abre com um texto neutro e a mensagem entra como resposta, com o
   * autor certo.
   *
   * Com vínculo já existente, o autor decide como entra: cliente como
   * resposta DELE, atendente em nome da pessoa, e o que é automático (menu,
   * saudação, transferência, posição na fila) em nome do atendente Bot —
   * senão o chamado vira um monólogo e quem o ler depois não sabe quem falou
   * o quê.
   */
  aoMensagem(dados: any, doEvento: "cliente" | "atendente"): Promise<void> {
    return this.emSequencia(dados?.ticket?.id, () => this.mensagem(dados, doEvento));
  }

  private async mensagem(dados: any, doEvento: "cliente" | "atendente"): Promise<void> {
    const { ticket, message, companyId } = dados;
    const config = await this.config(companyId);
    const api = await this.api(companyId);
    if (!api) return;

    const autor = autorDaMensagem(message, ticket, doEvento);
    const anexo = await baixarAnexo(message);
    const corpo = corpoDaMensagem(message, !!anexo);

    let vinculo = await this.lerVinculo(ticket?.id);

    // Nota interna do atendente: recado da equipe, que o cliente NÃO vê. Hoje
    // o backend nem a manda como "mensagem enviada" (ela tem evento próprio,
    // note:created) — esta trava existe para o dia em que isso mudar: como
    // resposta, ela ficaria visível ao cliente no TomTicket. Também nunca abre
    // chamado: nota não é atendimento.
    if (message?.isPrivate) {
      if (!vinculo || vinculo.finalizado) return;
      const nome = ticket?.user?.name || "Atendente";
      try {
        await this.emEnvios(`📝 Nota interna (${nome}): ${corpo}`, null, parte => api.comentarChamado(vinculo!.chamadoId, parte));
      } catch (err: any) {
        console.error(`${LOG} falha ao registrar nota interna no chamado ${vinculo.chamadoId}: ${err?.message || err}`);
      }
      return;
    }

    if (vinculo?.finalizado) {
      // O que chega com o ticket ainda fechado (despedida, pedido de avaliação,
      // a nota do cliente) pertence ao atendimento que acabou — e responder
      // reabriria o chamado. Cliente escrevendo com o ticket reaberto é
      // atendimento novo: o vínculo antigo é deixado de lado e abre-se outro.
      // Depois de uma TRANSFERÊNCIA o atendimento continua, então qualquer
      // mensagem (o atendente novo pode falar primeiro) abre o chamado seguinte.
      if (ticket?.status === "closed") return;
      if (autor !== "cliente" && vinculo.finalizadoPor !== "transferencia") return;
      vinculo = null;
    }
    if (!vinculo) {
      const doCliente = autor === "cliente";
      const [primeira, ...demais] = doCliente ? emPartes(corpo) : [ABERTURA_PELA_EMPRESA];
      vinculo = await this.abrirNaPrimeiraMensagem(api, config, ticket, primeira, doCliente ? anexo : null);
      if (!vinculo) return;
      if (doCliente) {
        // Texto longo demais para um envio: o resto vem como respostas dele.
        for (const parte of demais) await api.responderComoCliente(vinculo.chamadoId, parte);
        return;
      }
    }

    try {
      await this.registrar(api, config, ticket, vinculo, autor, corpo, anexo);
    } catch (err: any) {
      console.error(
        `${LOG} falha ao registrar mensagem no chamado ${vinculo.chamadoId}: ${err?.message || err}`
      );
    }
  }

  /**
   * Envia o texto em quantas partes forem precisas (ver emPartes), na ordem.
   * O anexo vai junto da primeira — repeti-lo em cada parte duplicaria o
   * arquivo no chamado.
   */
  private async emEnvios(
    corpo: string,
    anexo: Anexo | null,
    enviar: (parte: string, anexos?: Anexo[]) => Promise<unknown>
  ): Promise<void> {
    const partes = emPartes(corpo);
    for (let i = 0; i < partes.length; i++) {
      await enviar(partes[i], i === 0 && anexo ? [anexo] : undefined);
    }
  }

  /** Grava a mensagem no chamado em nome de `autor`. */
  private async registrar(
    api: TomTicketApi,
    config: ConfiguracaoTomTicket,
    ticket: any,
    vinculo: VinculoChamado,
    autor: Autor,
    corpo: string,
    anexo: Anexo | null
  ): Promise<void> {
    const id = vinculo.chamadoId;
    const comoCliente = (parte: string, anexos?: Anexo[]) => api.responderComoCliente(id, parte, anexos);
    const comoAtendente = (parte: string, anexos?: Anexo[]) => api.responderComoAtendente(id, parte, anexos);

    if (autor === "cliente") {
      await this.emEnvios(corpo, anexo, comoCliente);
      return;
    }

    if (autor === "bot") {
      if (!config.operadorBotId) {
        // Sem atendente Bot, responder como atendente sairia em nome de quem
        // estiver vinculado — ou do CLIENTE, se ninguém estiver. Comentário
        // interno é o único lugar onde não sai com o autor errado.
        await this.emEnvios(`🤖 Bot Markedesk: ${corpo}`, null, parte => api.comentarChamado(id, parte));
        return;
      }

      if (!(await this.garantirAtendente(api, ticket.id, vinculo, config.operadorBotId))) {
        throw new Error("atendente Bot não pôde ser vinculado — mensagem do bot não registrada");
      }
      await this.emEnvios(corpo, anexo, comoAtendente);

      // Atendimento já aceito (ex.: a mensagem de encerramento): o chamado
      // volta para a pessoa, senão terminaria no nome do Bot.
      const pessoa = ticket?.userId ? operadorDoUsuario(config, ticket.userId) : undefined;
      if (pessoa) await this.garantirAtendente(api, ticket.id, vinculo, pessoa);
      return;
    }

    const operadorId = this.responsavel(config, ticket?.userId);
    if (ticket?.userId && operadorId === config.operadorBotId) {
      console.warn(`${LOG} atendente ${ticket.userId} não mapeado no TomTicket — mensagem dele sai em nome do Bot (ticket ${ticket.id}).`);
    }
    const vinculado = operadorId
      ? await this.garantirAtendente(api, ticket.id, vinculo, operadorId)
      : !!vinculo.operadorAtual;

    if (!vinculado) {
      // Ninguém vinculado: a resposta de atendente seria gravada como do
      // cliente (ver responderComoAtendente). Comentário é o único lugar onde
      // não sai com o autor errado.
      const nome = ticket?.user?.name || "Atendente";
      await this.emEnvios(`${nome}: ${corpo}`, null, parte => api.comentarChamado(id, parte));
      return;
    }
    await this.emEnvios(corpo, anexo, comoAtendente);
  }

  /**
   * Tempo trabalhado para a finalização: da abertura do chamado até agora.
   *
   * A abertura vem do próprio TomTicket (`creation_date`), e não do vínculo,
   * para valer também nos chamados abertos antes desta versão. Sem a data, a
   * finalização sai sem o tempo — melhor que um número inventado.
   */
  private async minutosDoChamado(api: TomTicketApi, chamadoId: string): Promise<number | undefined> {
    try {
      const { data } = await api.detalharChamado(chamadoId);
      return minutosDesde(data?.creation_date);
    } catch {
      return undefined;
    }
  }

  /** O chamado do ticket, para o botão "Finalizar Chamado" saber se está disponível. */
  async consultar(
    ticketId: number | string
  ): Promise<{ protocolo?: string; finalizado: boolean; finalizadoPor?: MotivoDaFinalizacao } | null> {
    const vinculo = await this.lerVinculo(ticketId);
    if (!vinculo) return null;
    return {
      protocolo: vinculo.protocolo || vinculo.chamadoId,
      finalizado: !!vinculo.finalizado,
      finalizadoPor: vinculo.finalizadoPor
    };
  }

  /**
   * A transcrição de um áudio, feita pelo "Transcrever" do Markedesk, vai para
   * o chamado como comentário interno.
   *
   * Comentário, e não resposta: o texto não foi escrito por ninguém do
   * atendimento — é a IA lendo o áudio — e resposta de atendente ainda iria
   * por email ao cliente. O áudio original já está no chamado como anexo.
   *
   * O backend não avisa os plugins quando transcreve; quem traz o texto é o
   * botão do plugin, que enxerga a resposta da tela (ver BOTAO_FINALIZAR).
   */
  transcricao(dados: { ticketId: number | string; wid?: string; texto?: unknown }): Promise<void> {
    return this.emSequencia(dados.ticketId, () => this.registrarTranscricao(dados));
  }

  private async registrarTranscricao(dados: { ticketId: number | string; wid?: string; texto?: unknown }): Promise<void> {
    const texto = transcricaoValida(dados.texto);
    if (!texto) return;

    const api = await this.api();
    if (!api) return;

    const vinculo = await this.lerVinculo(dados.ticketId);
    // Chamado finalizado não recebe mais nada (ver VinculoChamado.finalizado).
    if (!vinculo || vinculo.finalizado) return;

    const wid = dados.wid ? String(dados.wid) : undefined;
    // Tabela própria (`transcricoes`), não mais uma lista dentro do vínculo:
    // o teto arbitrário de 50 áudios por chamado deixou de existir, e a
    // pergunta "já transcrevi este?" virou uma busca por chave primária.
    if (wid && this.vinculos.jaTranscrito(dados.ticketId, wid)) return;

    await this.emEnvios(textoDaTranscricao(texto), null, parte => api.comentarChamado(vinculo.chamadoId, parte));

    if (wid) this.vinculos.marcarTranscrito(dados.ticketId, wid);
    console.log(`${LOG} transcrição de áudio registrada no chamado ${vinculo.protocolo || vinculo.chamadoId} (ticket ${dados.ticketId})`);
  }

  /**
   * Finaliza o chamado do ticket, com o assunto principal (e o resumo, se
   * pedido) no texto da finalização.
   *
   * O resumo vem SEMPRE que a IA respondeu — mesmo com "não" ao resumo, é dele
   * que sai o assunto principal. `comResumo` só decide se o texto inteiro vai
   * junto. Lança quando não dá para finalizar: quem chamou (a tela) precisa
   * saber, para não resolver o atendimento como se tudo tivesse dado certo.
   */
  finalizar(dados: DadosDaFinalizacao): Promise<{ protocolo?: string; assunto?: string }> {
    let saida: { protocolo?: string; assunto?: string } = {};
    let falha: unknown;

    // Pela mesma fila das mensagens: uma resposta ainda em andamento não pode
    // chegar ao chamado depois de ele ser finalizado.
    return this.emSequencia(dados.ticketId, async () => {
      try {
        saida = await this.finalizarAgora(dados);
      } catch (err) {
        falha = err;
      }
    }).then(() => {
      if (falha) throw falha;
      return saida;
    });
  }

  private async finalizarAgora(dados: DadosDaFinalizacao): Promise<{ protocolo?: string; assunto?: string }> {
    const motivo = dados.motivo || "resolvido";
    const config = await this.config();
    const api = await this.api();
    if (!api) throw new Error("token do TomTicket não configurado");

    const vinculo = await this.lerVinculo(dados.ticketId);
    if (!vinculo) throw new Error("este atendimento não tem chamado no TomTicket");
    if (vinculo.finalizado) throw new Error(`o chamado ${vinculo.protocolo || vinculo.chamadoId} já foi finalizado`);

    // Finaliza em nome de quem resolveu, não do Bot que talvez esteja vinculado.
    const quem = (dados.userId ? operadorDoUsuario(config, dados.userId) : undefined) || vinculo.operadorAtual || config.operadorBotId;
    if (quem) await this.garantirAtendente(api, dados.ticketId, vinculo, quem);

    const assunto = extrairAssunto(dados.resumo);
    const partes = emPartes(textoDeFinalizacao({ assunto, resumo: dados.resumo, comResumo: dados.comResumo, motivo }));

    // Texto longo: as primeiras partes como respostas, a última finaliza.
    for (const parte of partes.slice(0, -1)) await api.responderComoAtendente(vinculo.chamadoId, parte);
    const minutos = await this.minutosDoChamado(api, vinculo.chamadoId);
    await api.finalizarChamado(vinculo.chamadoId, partes[partes.length - 1], minutos);

    vinculo.finalizado = true;
    vinculo.finalizadoPor = motivo;
    await this.gravarVinculo(dados.ticketId, vinculo);
    console.log(
      `${LOG} chamado ${vinculo.protocolo || vinculo.chamadoId} finalizado pelo ticket ${dados.ticketId}${motivo === "transferencia" ? " na transferência" : ""}${assunto ? ` (assunto: ${assunto})` : ""}${dados.comResumo && dados.resumo ? " com resumo" : ""}${minutos ? `, ${minutos} min` : ""}`
    );
    return { protocolo: vinculo.protocolo, assunto };
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
    mensagemInicial: string,
    anexo: Anexo | null
  ): Promise<VinculoChamado | null> {
    const daFila = ticket?.queueId ? destinoDaFila(config, ticket.queueId) : null;
    const destino = daFila || (config.setorInicial ? { departamentoId: config.setorInicial, categoriaId: config.categoriaInicial } : null);

    if (!destino) {
      console.warn(
        `${LOG} ticket ${ticket?.id}: nem a fila atual nem o setor inicial estão configurados — chamado não criado.`
      );
      return null;
    }

    return this.abrirChamado(api, config, ticket, destino, mensagemInicial, anexo);
  }
}
