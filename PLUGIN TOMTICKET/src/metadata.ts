import { definePlugin, defineStoreListing, HOOK_EVENTS } from "@markedesk/plugin-sdk";
import { PLUGIN_ID, PLUGIN_NOME } from "@/identidade";
import { TELA_DE_CATEGORIAS } from "@/ui/telaDeCategorias";

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
  color: "#0B7FD4",
  icon: "Forum",
  version: "0.1.2",
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
      { name: "categorias", label: "Categorias", icon: "Category", order: 3 }
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
       * De-para dos atendentes.
       *
       * Os dois lados são seletores, e não campos de texto, porque os ids do
       * TomTicket são hashes de 32 caracteres: digitar à mão erra, e o erro só
       * aparece quando a ação falha no meio de um atendimento.
       */
      {
        name: "atendentes",
        type: "list",
        label: "Atendentes",
        tab: "atendentes",
        addButtonText: "Adicionar atendente",
        itemLabel: "usuarioId",
        fields: [
          {
            name: "usuarioId",
            label: "Atendente no Markedesk",
            type: "select",
            source: "users",
            required: true
          },
          {
            name: "operadorId",
            label: "Atendente no TomTicket",
            type: "select",
            endpoint: "/opcoes/atendentes",
            required: true,
            helpText: "Lista carregada da sua conta do TomTicket."
          }
        ]
      },

      /**
       * De-para das filas.
       *
       * Só até o setor: a categoria é escolhida por setor na aba Categorias,
       * não por fila. Duas filas que caem no mesmo setor abrem chamado na mesma
       * categoria, que é como o TomTicket organiza o assunto.
       */
      {
        name: "filas",
        type: "list",
        label: "Filas",
        tab: "filas",
        addButtonText: "Adicionar fila",
        itemLabel: "filaId",
        fields: [
          {
            name: "filaId",
            label: "Fila no Markedesk",
            type: "select",
            source: "queues",
            required: true
          },
          {
            name: "departamentoId",
            label: "Departamento no TomTicket",
            type: "select",
            endpoint: "/opcoes/departamentos",
            required: true
          }
        ]
      },

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
