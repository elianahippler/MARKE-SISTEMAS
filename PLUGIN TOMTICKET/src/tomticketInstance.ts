import { HOOK_EVENTS, PluginServer } from "@markedesk/plugin-sdk";
import { metadata } from "@/metadata";
import { LOG } from "@/identidade";
import { TomTicketApi } from "@/tomticket/api";
import { FluxoChamados } from "@/fluxo/chamados";
import {
  clienteTomTicket,
  guardarNaMemoria,
  lerConfiguracao,
  lerDaMemoria,
  persistirConfiguracao,
  AVISO_SEM_TOKEN,
  type ConfiguracaoTomTicket
} from "@/config/settings";

export interface CreateInstanceOptions {
  port?: number;
  configFile?: string;
}

export interface TomTicketInstance {
  server: PluginServer;
}

/**
 * Fábrica de UMA instância do plugin — uma empresa.
 *
 * Separada do `index.ts` para o mesmo código servir também ao modo
 * multi-tenant no futuro: tudo que seria global vive na closure da instância.
 */
export function createTomTicketInstance(opts: CreateInstanceOptions = {}): TomTicketInstance {
  // Criado depois do server (usa-o para storage e configuração), mas declarado
  // aqui para o onHook abaixo enxergá-lo pela closure.
  let fluxo: FluxoChamados;

  const server: PluginServer = new PluginServer({
    metadata,
    port: opts.port,
    configFile: opts.configFile,

    /**
     * O despacho dos eventos do atendimento.
     *
     * Cada ramo é isolado por try/catch no fluxo: hook é best-effort — o
     * backend não reenvia, e uma falha ao espelhar no TomTicket não pode
     * atrapalhar o atendimento em si.
     */
    async onHook(event, data: any) {
      if (event === "plugin:settingsChanged") {
        const { companyId, settings } = data as {
          companyId: number;
          settings: ConfiguracaoTomTicket;
        };

        guardarNaMemoria(companyId, settings);
        await persistirConfiguracao(server, settings);
        console.log(
          `${LOG} empresa ${companyId} salvou a configuração (token ${settings.apiToken ? "definido" : "vazio"})`
        );
        return;
      }

      switch (event) {
        case HOOK_EVENTS.ticket.TRANSFERRED:
          return fluxo.aoTransferir(data);
        case HOOK_EVENTS.ticket.ASSIGNED:
          return fluxo.aoAtribuir(data);
        case HOOK_EVENTS.ticket.MESSAGE_RECEIVED:
          return fluxo.aoMensagem(data, "cliente");
        case HOOK_EVENTS.ticket.MESSAGE_SENT:
          return fluxo.aoMensagem(data, "atendente");
      }
    },

    routes(router) {
      /**
       * Checagem de que o token configurado funciona.
       *
       * Existe porque, sem isto, descobrir que o token está errado só acontece
       * na primeira ação real — no meio de um atendimento.
       */
      router.get("/status", async (_req, res) => {
        const api = await clienteTomTicket(server);
        if (!api) return res.status(400).json({ ok: false, erro: AVISO_SEM_TOKEN });

        try {
          const departamentos = await api.listarDepartamentos();
          return res.json({ ok: true, departamentos: departamentos.data?.length ?? 0 });
        } catch (err: any) {
          return res.status(502).json({ ok: false, erro: err?.message || String(err) });
        }
      });

      /**
       * O botão "Testar conexão" da aba Conexão.
       *
       * POST com `{ values }` — os settings do FORMULÁRIO, ainda não salvos.
       * Testar só o que já foi salvo obrigaria a salvar errado para descobrir
       * que está errado. A resposta `{ result, severity }` vira o toast.
       *
       * Salva `values` (memória + storage) quando o teste passa — sem isto, as
       * abas Atendentes/Filas/Categorias, que dependem do token para carregar
       * suas listas, ficavam vazias até o usuário clicar em Salvar (a tela
       * inteira) E fechar/reabrir o modal (os campos já montados não refazem
       * o fetch sozinhos). Confirmado ao vivo em 30/09/2026. Só salva em
       * sucesso: persistir um token que não funciona quebraria as outras abas
       * do mesmo jeito, só que caladamente.
       */
      router.post("/testar", async (req, res) => {
        const token = req.body?.values?.apiToken;
        if (!token) {
          return res.json({ result: "Informe o token antes de testar.", severity: "warning" });
        }

        try {
          const atendentes = await new TomTicketApi(token).listarAtendentes();

          const companyId = server.getCompanyId();
          if (companyId != null) {
            const values = req.body.values as ConfiguracaoTomTicket;
            guardarNaMemoria(companyId, values);
            await persistirConfiguracao(server, values);
          }

          return res.json({
            result: `Conexão OK — ${atendentes.length} atendentes encontrados. Token salvo.`,
            severity: "success"
          });
        } catch (err: any) {
          return res.json({
            result: `Falhou: ${err?.message || err}`,
            severity: "error"
          });
        }
      });

      /**
       * As opções dos seletores de mapeamento.
       *
       * Devolvem `{ options: [] }` em vez de erro quando o token ainda não foi
       * salvo: o formulário abre antes de existir configuração, e um 400 aqui
       * deixaria a aba quebrada em vez de vazia.
       */
      const opcoes = (
        caminho: string,
        buscar: (api: TomTicketApi) => Promise<Array<{ value: string; label: string }>>
      ) =>
        router.get(caminho, async (_req, res) => {
          const api = await clienteTomTicket(server);
          if (!api) return res.json({ options: [] });

          try {
            return res.json({ options: await buscar(api) });
          } catch (err: any) {
            console.error(`${LOG} falha ao carregar ${caminho}: ${err?.message || err}`);
            return res.json({ options: [] });
          }
        });

      opcoes("/opcoes/atendentes", async api =>
        (await api.listarAtendentes()).map(a => ({ value: a.id, label: a.name }))
      );

      /**
       * O chamado do ticket, para o botão "Resolver + TomTicket".
       *
       * O botão só aparece quando há chamado aberto — sem isto ele ofereceria
       * finalizar algo que não existe. Leva junto o plugin de IA configurado,
       * que a tela usa para pedir o resumo.
       */
      router.get("/chamado", async (req, res) => {
        const ticketId = String(req.query?.ticketId || "");
        if (!ticketId) return res.json({ chamado: null });

        const chamado = await fluxo.consultar(ticketId);
        const config = lerDaMemoria() || (await lerConfiguracao(server));
        return res.json({ chamado, pluginIaId: config.pluginIaId || null });
      });

      /**
       * Finaliza o chamado do ticket. Chamado pela tela ANTES de resolver o
       * atendimento: se falhar, a tela avisa e o atendimento segue aberto, em
       * vez de resolvido com o chamado pendurado no TomTicket.
       */
      router.post("/chamado/finalizar", async (req, res) => {
        const { ticketId, userId, comResumo, resumo } = req.body || {};
        if (!ticketId) return res.status(400).json({ error: "ticketId ausente" });

        try {
          const feito = await fluxo.finalizar({
            ticketId,
            userId,
            comResumo: !!comResumo,
            resumo: typeof resumo === "string" ? resumo : null
          });
          return res.json({ ok: true, ...feito });
        } catch (err: any) {
          console.error(`${LOG} falha ao finalizar o chamado do ticket ${ticketId}: ${err?.message || err}`);
          return res.status(502).json({ error: err?.message || String(err) });
        }
      });

      /**
       * Atendentes e filas do MARKEDESK, para as abas de de-para.
       *
       * Vêm pelo plugin, e não direto do backend, porque a tela JSX só alcança
       * as rotas do próprio plugin (`props.api`). Não dependem do token do
       * TomTicket — só da instalação provisionada.
       */
      const doMarkedesk = (caminho: string, buscar: () => Promise<Array<{ value: string; label: string }>>) =>
        router.get(caminho, async (_req, res) => {
          if (!server.client) return res.json({ options: [] });
          try {
            const itens = await buscar();
            return res.json({ options: itens.map(i => ({ value: String(i.value), label: i.label })) });
          } catch (err: any) {
            console.error(`${LOG} falha ao carregar ${caminho}: ${err?.message || err}`);
            return res.json({ options: [] });
          }
        });

      doMarkedesk("/opcoes/usuarios-markedesk", () => server.client!.listUsers());
      doMarkedesk("/opcoes/filas-markedesk", () => server.client!.listQueues());

      opcoes("/opcoes/campos-personalizados", async api =>
        (await api.listarCamposPersonalizados()).map(c => ({ value: c.id, label: c.label }))
      );

      opcoes("/opcoes/departamentos", async api =>
        (await api.listarDepartamentos()).data!.map((d: any) => ({
          value: d.id,
          label: d.name
        }))
      );

      /**
       * Setores com as categorias de cada um, para a aba Categorias.
       *
       * Uma chamada só, e não uma por setor: a API do TomTicket já devolve as
       * categorias aninhadas no departamento, e N chamadas só atrasariam a tela.
       */
      router.get("/opcoes/setores", async (_req, res) => {
        const api = await clienteTomTicket(server);
        if (!api) return res.json({ setores: [] });

        try {
          const { data } = await api.listarDepartamentos(true);
          const setores = (data || []).map((departamento: any) => ({
            id: departamento.id,
            nome: departamento.name,
            categorias: (departamento.categories || []).map((categoria: any) => ({
              id: categoria.id,
              nome: categoria.name
            }))
          }));
          return res.json({ setores });
        } catch (err: any) {
          console.error(`${LOG} falha ao carregar setores: ${err?.message || err}`);
          return res.json({ setores: [] });
        }
      });
    }
  });

  fluxo = new FluxoChamados(server);

  return { server };
}
