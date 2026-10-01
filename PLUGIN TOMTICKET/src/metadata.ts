import { definePlugin, defineStoreListing, HOOK_EVENTS } from "@markedesk/plugin-sdk";
import { PLUGIN_ID, PLUGIN_NOME } from "@/identidade";
import { TELA_DE_CATEGORIAS } from "@/ui/telaDeCategorias";
import { TELA_DE_ATENDENTES, TELA_DE_FILAS } from "@/ui/telaDeDePara";
import { BOTAO_RESOLVER, TELA_DE_IA } from "@/ui/resolverTomTicket";
import { TELA_DE_DIAGNOSTICO } from "@/ui/telaDeDiagnostico";

/**
 * O que este plugin oferece.
 *
 * As ações ainda não estão declaradas: é o próximo passo, junto com as rotas
 * que as atendem em `tomticketInstance.ts`.
 *
 * `icon` sai do mapa FECHADO do front (`components/ChannelIcon/index.js`):
 * WhatsApp, Facebook, Instagram, Telegram, SmartToy, Webhook, Sms, Email,
 * Forum, Chat. Nome fora dele vira o ícone padrão em silêncio.
 */
export const metadata = definePlugin({
  id: PLUGIN_ID,
  displayName: PLUGIN_NOME,
  // Cor e símbolo mais próximos da marca: o ícone do TomTicket é um balão
  // em forma de ticket, coral. Imagem não é aceita aqui (mapa fechado abaixo);
  // o logo de verdade aparece no botão "Resolver + TomTicket".
  color: "#F76045",
  icon: "Chat",
  version: "0.1.7",
  minSdkVersion: "1.28.0",
  description: "Integração com o TomTicket — chamados de suporte dentro do atendimento.",

  store: defineStoreListing({
    category: "Integrações",
    tagline: "Os chamados do TomTicket dentro do Markedesk.",
    summary: "Consulta e abertura de chamados do TomTicket durante o atendimento.",
    description:
      "Liga o atendimento do Markedesk ao help desk do TomTicket, para quem atende " +
      "não precisar trocar de sistema para ver ou abrir um chamado.",
    maintainer: {
      name: "Marke Sistemas",
      kind: "product-team",
      about: "Desenvolvido e mantido pela Marke Sistemas.",
      support: "Abra um chamado pelo canal de suporte da Marke Sistemas."
    },
    partner: {
      name: "TomTicket",
      role:
        "Fornece o help desk. A conta e o plano são contratados diretamente com eles — " +
        "o Markedesk não intermedeia.",
      website: "https://www.tomticket.com"
    },
    keywords: ["tomticket", "help desk", "chamado", "suporte", "ticket"]
  }),

  provides: {
    settingsTabs: [
      { name: "conexao", label: "Conexão", icon: "VpnKey", order: 0 },
      { name: "atendentes", label: "Atendentes", icon: "People", order: 1 },
      { name: "filas", label: "Filas", icon: "Forum", order: 2 },
      { name: "categorias", label: "Categorias", icon: "Category", order: 3 },
      { name: "ia", label: "IA", icon: "Android", order: 4 },
      { name: "diagnostico", label: "Diagnóstico", icon: "BugReport", order: 5 }
    ],

    settings: [
      {
        name: "apiToken",
        label: "Token da API",
        type: "password",
        required: true,
        tab: "conexao",
        helpText:
          "Gerado no painel do TomTicket, em Configurações → API. Fica salvo por empresa."
      },
      {
        type: "button",
        label: "Testar conexão",
        variant: "primary",
        icon: "Build",
        endpoint: "/testar",
        tab: "conexao"
      },
      {
        name: "campoProtocoloId",
        label: "Campo do protocolo Markedesk",
        type: "select",
        endpoint: "/opcoes/campos-personalizados",
        tab: "conexao",
        helpText:
          "Campo personalizado do chamado que recebe o id do ticket. Só é gravado nas categorias onde o campo existe."
      },
      {
        name: "webhookVinculo",
        label: "Webhook do n8n (grava o vínculo no banco)",
        type: "text",
        tab: "conexao",
        placeholder: "https://editor.n8n.markesistemas.com.br/webhook/plugin-tomticket-vinculo",
        helpText:
          "A cada chamado aberto, grava ticket + chamado na tabela comunica. Deixar vazio desliga a gravação — o plugin continua funcionando."
      },
      {
        type: "alert",
        variant: "info",
        label: "Salve o token antes de mapear",
        content:
          "As listas de atendentes, departamentos e categorias são buscadas no TomTicket " +
          "com o token acima. Enquanto ele não estiver salvo, os seletores das outras abas " +
          "aparecem vazios.",
        tab: "conexao"
      },

      /**
       * De-para dos atendentes, mais o atendente Bot — escolhidos por nome.
       *
       * Tela do plugin, e não `list` + `select`: o `select` com `endpoint`
       * não carrega dentro de item de lista (ver o topo de telaDeDePara.ts). O
       * Bot mora aqui por usar a mesma lista de atendentes do TomTicket; ele
       * precisa ser ATENDENTE porque a resposta de atendente sai em nome de
       * quem está vinculado, e a de cliente sempre em nome do dono do chamado.
       */
      {
        name: "atendentes",
        type: "jsx",
        tab: "atendentes",
        content: TELA_DE_ATENDENTES
      } as any,

      /**
       * De-para das filas, escolhido por nome.
       *
       * Só até o departamento: a categoria é escolhida por departamento na aba
       * Categorias, não por fila. Duas filas que caem no mesmo departamento
       * abrem chamado na mesma categoria, que é como o TomTicket organiza o
       * assunto.
       */
      {
        name: "filas",
        type: "jsx",
        tab: "filas",
        content: TELA_DE_FILAS
      } as any,

      /**
       * Uma categoria padrão por setor.
       *
       * Tela desenhada pelo plugin porque a escolha é dependente — as opções de
       * cada linha são as categorias daquele setor, e o `select` declarativo
       * busca de um endpoint fixo, sem enxergar o valor de outro campo.
       */
      {
        name: "categoriasPorSetor",
        type: "jsx",
        tab: "categorias",
        content: TELA_DE_CATEGORIAS
      } as any,

      /** Qual plugin de IA gera o resumo do "Resolver + TomTicket". */
      {
        name: "pluginIaId",
        type: "jsx",
        tab: "ia",
        content: TELA_DE_IA
      } as any,

      /**
       * Últimos erros, avisos e chamados. Sem `name`: só mostra, não grava
       * nada na configuração.
       */
      {
        type: "jsx",
        tab: "diagnostico",
        content: TELA_DE_DIAGNOSTICO
      } as any
    ],

    /**
     * "Resolver + TomTicket", no cabeçalho do atendimento, ao lado do Resolver.
     *
     * `render: "jsx"` (o plugin desenha o botão e o diálogo) não está no tipo
     * do SDK 1.28, mas o frontend 4.10.4 já trata — mesmo recurso que o
     * plugin-day-tools usa. Por que botão e não opção no diálogo "Resolver":
     * ver o topo de src/ui/resolverTomTicket.ts.
     */
    actions: [
      {
        id: "resolver-tomticket",
        label: "Resolver + TomTicket",
        icon: "Build",
        slot: "ticket-header",
        render: "jsx",
        jsx: BOTAO_RESOLVER
      } as any
    ],

    /**
     * O ciclo do atendimento espelhado no TomTicket.
     *
     * `plugin:settingsChanged` não é opcional nem quando só interessa a
     * configuração: o SDK só monta a rota `POST /hook` se houver ao menos um
     * hook declarado, e sem ela o backend posta, toma 404 e o evento se perde
     * sem erro nos dois lados.
     */
    hooks: [
      { event: "plugin:settingsChanged" },
      { event: HOOK_EVENTS.ticket.TRANSFERRED },
      { event: HOOK_EVENTS.ticket.ASSIGNED },
      { event: HOOK_EVENTS.ticket.MESSAGE_RECEIVED },
      { event: HOOK_EVENTS.ticket.MESSAGE_SENT }
    ],

    routes: true
  }
});
