import type { PluginServer } from "@markedesk/plugin-sdk";
import { LOG } from "@/identidade";
import { TomTicketApi } from "@/tomticket/api";

/**
 * Configuração do plugin, por empresa.
 *
 * Vive em dois lugares por necessidade: o backend grava o que a empresa salva
 * na tela e empurra por `plugin:settingsChanged`; o plugin guarda uma cópia no
 * PluginStorage. A cópia existe porque hook e job rodam SEM usuário logado — e
 * porque o empurrão é best-effort: se o plugin estiver fora do ar na hora do
 * save, o evento não é reenviado.
 */
/** De-para de um atendente do Markedesk para o operador dele no TomTicket. */
export interface MapeamentoAtendente {
  /** Id do usuário no Markedesk (vem do seletor com `source: "users"`). */
  usuarioId?: string;
  /** Id do atendente no TomTicket (hash). */
  operadorId?: string;
}

/** De-para de uma fila do Markedesk para o setor dela no TomTicket. */
export interface MapeamentoFila {
  /** Id da fila no Markedesk (vem do seletor com `source: "queues"`). */
  filaId?: string;
  /** Id do setor (departamento) no TomTicket (hash). */
  departamentoId?: string;
}

export interface ConfiguracaoTomTicket {
  /** Token de API (Bearer) gerado no painel do TomTicket. */
  apiToken?: string;
  atendentes?: MapeamentoAtendente[];
  /**
   * Atendente do TomTicket que assina as mensagens automáticas (menu, saudação,
   * transferência, posição na fila).
   *
   * Precisa ser ATENDENTE, não cliente: a API só deixa responder em nome do
   * atendente vinculado ou do cliente dono do chamado — não há como escolher
   * outro cliente. Vazio, a mensagem automática entra como comentário interno.
   */
  operadorBotId?: string;
  filas?: MapeamentoFila[];
  /**
   * Categoria padrão de cada setor: `{ [departamentoId]: categoriaId }`.
   *
   * Por setor, e não por fila, porque é assim que o TomTicket organiza o
   * assunto — duas filas que caem no mesmo setor abrem na mesma categoria.
   */
  categoriasPorSetor?: Record<string, string>;
  /**
   * Onde nasce o chamado, antes de o atendimento entrar numa fila.
   *
   * O ticket do Markedesk é aberto sem fila — a fila só é definida depois, pelo
   * chatbot ou pelo atendente. Sem um destino inicial não haveria onde criar o
   * chamado, e o registro do atendimento começaria só na transferência.
   */
  setorInicial?: string;
  categoriaInicial?: string;
  /**
   * Campo personalizado do chamado que recebe o id do ticket do Markedesk.
   *
   * Configurável em vez de fixo no código: o id é um hash gerado pelo
   * TomTicket, e recriar o campo lá geraria outro — com o id no código, o
   * plugin passaria a gravar num campo que não existe mais, calado.
   */
  campoProtocoloId?: string;
  /**
   * Plugin de IA que gera o resumo no "Finalizar Chamado" e na transferência (id dele no
   * Markedesk, ex.: "ai-tools").
   *
   * Configurável porque o resumo é chamado pela rota do OUTRO plugin
   * (`/p/{hash}/{id}/acoes/resumir`), e a empresa pode ter o AI-Tools com outro
   * id — ou nenhum. Vazio: o chamado é finalizado sem resumo nem assunto.
   */
  pluginIaId?: string;
}

/**
 * O operador do TomTicket correspondente a um usuário do Markedesk.
 *
 * Comparação por string dos dois lados: o id do Markedesk é número no banco,
 * mas chega do formulário como texto — comparar sem normalizar não casa nunca.
 */
export function operadorDoUsuario(
  config: ConfiguracaoTomTicket,
  usuarioId: number | string
): string | undefined {
  const alvo = String(usuarioId);
  return config.atendentes?.find(m => String(m.usuarioId) === alvo)?.operadorId;
}

/**
 * Onde abrir o chamado de um atendimento: setor e categoria no TomTicket.
 *
 * A fila leva ao setor, e o setor leva à categoria — a categoria não é
 * configurada por fila. Devolve `null` quando a fila não está mapeada.
 */
export function destinoDaFila(
  config: ConfiguracaoTomTicket,
  filaId: number | string
): { departamentoId: string; categoriaId?: string } | null {
  const alvo = String(filaId);
  const departamentoId = config.filas?.find(m => String(m.filaId) === alvo)?.departamentoId;
  if (!departamentoId) return null;

  return { departamentoId, categoriaId: config.categoriasPorSetor?.[departamentoId] };
}

/** Cache em memória por empresa, alimentado pelo hook de settings. */
const porEmpresa = new Map<number, ConfiguracaoTomTicket>();

export function guardarNaMemoria(companyId: number, config: ConfiguracaoTomTicket): void {
  porEmpresa.set(companyId, config);
}

/**
 * A configuração em memória.
 *
 * Sem `companyId` devolve a única que houver — o plugin é single-tenant, então
 * "a empresa" é sempre a mesma. Isso serve às rotas que o formulário de
 * settings chama: elas não recebem companyId, e a memória está mais fresca que
 * o storage (o hook acabou de entregá-la).
 */
export function lerDaMemoria(companyId?: number): ConfiguracaoTomTicket | undefined {
  if (companyId !== undefined) return porEmpresa.get(companyId);
  return porEmpresa.size === 1 ? [...porEmpresa.values()][0] : undefined;
}

/** Lê a cópia persistida (funciona sem usuário logado). */
export async function lerConfiguracao(server: PluginServer): Promise<ConfiguracaoTomTicket> {
  if (!server.client) return {};
  try {
    return (await server.client.storage.get<ConfiguracaoTomTicket>("settings")) || {};
  } catch {
    return {};
  }
}

export async function persistirConfiguracao(
  server: PluginServer,
  config: ConfiguracaoTomTicket
): Promise<void> {
  try {
    await server.client?.storage.set("settings", config);
  } catch (err: any) {
    console.warn(`${LOG} não consegui persistir a configuração: ${err?.message || err}`);
  }
}

/**
 * Cliente da API pronto para uso, ou `null` quando ainda não há token.
 *
 * Devolver `null` em vez de lançar deixa a decisão com quem chamou: uma ação
 * disparada pelo atendente quer avisar na tela; um job quer sair calado.
 */
export async function clienteTomTicket(
  server: PluginServer,
  companyId?: number
): Promise<TomTicketApi | null> {
  const config = lerDaMemoria(companyId) || (await lerConfiguracao(server));

  if (!config.apiToken) return null;
  return new TomTicketApi(config.apiToken);
}

/** Mensagem única para a causa mais comum de "não funciona". */
export const AVISO_SEM_TOKEN =
  "Token do TomTicket não configurado. Vá em Plugins → TomTicket → Configurar.";
