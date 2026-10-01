/**
 * O botão "Finalizar Chamado (#protocolo) TomTicket" e a aba "IA" da
 * configuração.
 *
 * POR QUE UM BOTÃO, e não uma 3ª opção no diálogo "Resolver": os botões desse
 * diálogo são fixos no core (TicketActionButtonsCustom), sem ponto para plugin
 * acrescentar opção. E interceptar `resolve-ticket` não serve: o "Resolver" do
 * cabeçalho chama `PUT /tickets/:id` direto, sem passar pelo interceptador (só
 * o resolver da LISTA de tickets passa). O slot `ticket-header` põe o botão ao
 * lado do "Resolver", que é onde a pessoa procura.
 *
 * SEMPRE VISÍVEL, desabilitado enquanto não há chamado aberto. Antes ele
 * sumia sem chamado — e consultava uma vez só, ao abrir o ticket: quando o
 * chamado nascia depois (na primeira mensagem), o botão continuava escondido
 * até trocar de ticket. Agora a consulta se repete enquanto o ticket está na
 * tela.
 *
 * A ordem do fluxo importa: resumo → finaliza o chamado → resolve o
 * atendimento. O atendimento só é resolvido se o chamado foi finalizado; ao
 * contrário, uma falha deixaria o atendimento fechado e o chamado pendurado.
 * Resolve SEM mensagem de despedida: a despedida chegaria ao plugin depois de
 * o chamado já estar finalizado.
 *
 * O botão também escuta o cliente HTTP do app (`runtime.api`, a mesma
 * instância que as telas do Markedesk usam), para duas coisas que o backend
 * não avisa aos plugins:
 *
 * - TRANSFERÊNCIA (`PUT /tickets/:id` com `isTransfered`): antes de ela sair,
 *   gera o resumo e finaliza o chamado. Tem que ser aqui, e não no evento
 *   `ticket:transferred` do servidor, porque o resumo do AI-Tools lê as
 *   mensagens com o login de quem clicou — sem usuário, sai vazio. O
 *   servidor finaliza (sem resumo) o que escapar daqui.
 * - TRANSCRIÇÃO (`POST /message/transcribeAudio`): o texto devolvido vai para
 *   o chamado. O backend só grava a transcrição na mensagem, sem evento.
 *
 * Os interceptadores são registrados uma vez por página (marcados em
 * `window.__pluginTomTicket`), e não um por botão montado: cada ticket aberto
 * montaria outro, e a transferência finalizaria o chamado duas vezes.
 *
 * LIMITAÇÃO ACEITA: JSX-string não tem type-check nem imports. Tudo vem de
 * `props` — `props.runtime.api` é o cliente do app, com a sessão de quem
 * clicou; `props.api` é o mesmo, já apontado para as rotas deste plugin.
 */

import { BORDA_TOMTICKET, COR_TOMTICKET, FUNDO_TOMTICKET, LOGO_TOMTICKET } from "@/ui/logoTomTicket";

/**
 * Muda quando o código dos interceptadores muda: a página que já tinha a
 * versão anterior registrada troca pela nova sem precisar recarregar.
 */
const VERSAO_DOS_INTERCEPTADORES = "2026-10-01.1";

export const BOTAO_FINALIZAR = `
  const { useState, useEffect } = React;
  const { Button, Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress, Typography, Box, Tooltip, Snackbar } = props.mui;
  const runtime = props.runtime || (typeof window !== "undefined" ? window.markedeskRuntime : null) || {};
  const ticketId = props.context && props.context.ticketId;

  const [info, setInfo] = useState(null);
  const [aberto, setAberto] = useState(false);
  const [etapa, setEtapa] = useState(null);
  const [erro, setErro] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [avisoDeFundo, setAvisoDeFundo] = useState(null);

  // O plugin de IA mora na mesma empresa: troca só o id no fim do caminho
  // (/p/{hash}/{pluginId}).
  function rotaDaIa(routePath, pluginIaId) {
    if (!pluginIaId || !routePath) return null;
    return routePath.replace(/\\/[^\\/]+$/, "/" + pluginIaId) + "/acoes/resumir";
  }

  // O chamado nasce na primeira mensagem, que pode chegar com o ticket já na
  // tela — por isso a consulta se repete. Falha passageira mantém o que já se
  // sabia, em vez de desabilitar o botão.
  useEffect(function () {
    let vivo = true;
    setInfo(null);
    if (!ticketId) return undefined;
    function atualizar() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      props.api.get("/chamado?ticketId=" + ticketId)
        .then(function (res) { if (vivo) setInfo(res.data || null); })
        .catch(function () {});
    }
    atualizar();
    const relogio = setInterval(atualizar, 10000);
    return function () { vivo = false; clearInterval(relogio); };
  }, [ticketId]);

  // Transferência e transcrição — ver o topo de resolverTomTicket.ts.
  useEffect(function () {
    const app = runtime.api;
    if (!app || !app.interceptors || typeof window === "undefined") return undefined;
    const g = window.__pluginTomTicket || (window.__pluginTomTicket = {});
    g.ticketId = ticketId;
    g.api = props.api;
    g.routePath = props.routePath;
    g.usuarioId = runtime.user && runtime.user.id;
    g.avisar = setAvisoDeFundo;

    if (g.versao !== "${VERSAO_DOS_INTERCEPTADORES}") {
      if (g.ids) {
        try { app.interceptors.request.eject(g.ids.pedido); app.interceptors.response.eject(g.ids.resposta); } catch (e) {}
      }

      function corpoDe(config) {
        let corpo = config && config.data;
        if (typeof corpo === "string") { try { corpo = JSON.parse(corpo); } catch (e) { corpo = null; } }
        return corpo || {};
      }

      function avisar(texto) { if (g.avisar) { try { g.avisar(texto); } catch (e) {} } }

      async function finalizarNaTransferencia(id) {
        const r = await g.api.get("/chamado?ticketId=" + id);
        const d = r && r.data;
        if (!d || !d.chamado || d.chamado.finalizado) return;
        const numero = d.chamado.protocolo ? " #" + d.chamado.protocolo : "";

        let resumo = null;
        const rota = rotaDaIa(g.routePath, d.pluginIaId);
        if (rota) {
          avisar("Gerando o resumo do chamado" + numero + " antes de transferir...");
          try {
            const ia = await app.post(rota, { ticketId: Number(id) }, { timeout: 45000 });
            const dados = ia && ia.data;
            if (dados && !dados.erro && typeof dados.result === "string") resumo = dados.result;
          } catch (e) { /* sai sem resumo */ }
        }

        avisar("Finalizando o chamado" + numero + " no TomTicket...");
        await g.api.post("/chamado/finalizar", {
          ticketId: Number(id),
          userId: g.usuarioId || null,
          comResumo: !!resumo,
          resumo: resumo,
          motivo: "transferencia"
        }, { timeout: 30000 });
      }

      // Espera a finalização ANTES de deixar a transferência sair: depois
      // dela, a primeira mensagem da fila nova já abriria o chamado seguinte.
      // Qualquer falha libera a transferência — o servidor finaliza sem resumo.
      async function antesDaTransferencia(config) {
        try {
          const m = /\\/tickets\\/(\\d+)\\/?$/.exec(String((config && config.url) || ""));
          if (m && String(config.method).toLowerCase() === "put" && corpoDe(config).isTransfered && g.api) {
            await finalizarNaTransferencia(m[1]);
          }
        } catch (e) {
          /* a transferência segue */
        } finally {
          avisar(null);
        }
        return config;
      }

      // Não espera nem altera a resposta: a tela do Markedesk segue igual.
      function depoisDaTranscricao(resposta) {
        try {
          const config = resposta && resposta.config;
          if (!config || !/\\/message\\/transcribeAudio\\/?$/.test(String(config.url || ""))) return;
          if (!g.api || !g.ticketId || typeof resposta.data !== "string") return;
          g.api.post("/chamado/transcricao", {
            ticketId: g.ticketId,
            wid: corpoDe(config).wid,
            texto: resposta.data
          }).catch(function () {});
        } catch (e) {}
      }

      g.versao = "${VERSAO_DOS_INTERCEPTADORES}";
      g.ids = {
        pedido: app.interceptors.request.use(antesDaTransferencia),
        resposta: app.interceptors.response.use(function (resposta) { depoisDaTranscricao(resposta); return resposta; })
      };
    }

    return function () {
      if (g.ticketId === ticketId) g.ticketId = null;
      if (g.avisar === setAvisoDeFundo) g.avisar = null;
    };
  }, [ticketId]);

  const chamado = info && info.chamado;
  const protocolo = chamado && chamado.protocolo;
  const disponivel = !!(chamado && !chamado.finalizado);
  const ocupado = !!etapa;
  const rota = info ? rotaDaIa(props.routePath, info.pluginIaId) : null;

  const rotulo = "Finalizar Chamado" + (protocolo ? " (#" + protocolo + ")" : "") + " TomTicket";
  const dica = !chamado
    ? "O chamado é aberto no TomTicket com a primeira mensagem do atendimento."
    : chamado.finalizado
      ? (chamado.finalizadoPor === "transferencia"
          ? "Chamado #" + protocolo + " finalizado na transferência. O próximo abre com a próxima mensagem."
          : "Chamado #" + protocolo + " já finalizado.")
      : "Gera o resumo, finaliza o chamado no TomTicket e resolve o atendimento.";

  function mensagemDe(e) {
    return (e && e.response && e.response.data && e.response.data.error) || (e && e.message) || String(e);
  }

  function irParaLista() {
    // O "Resolver" nativo faz history.push("/tickets"); sem acesso ao history
    // do app, o popstate faz o roteador dele reagir à URL nova.
    try {
      window.history.pushState({}, "", "/tickets");
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) { /* fica na tela; o socket atualiza o ticket */ }
  }

  async function executar(comResumo) {
    setErro(null);
    setAviso(null);
    const usuarioId = runtime.user && runtime.user.id;

    // O resumo é pedido SEMPRE: mesmo sem anexá-lo, é dele que sai o assunto
    // principal. Falhar aqui não impede de finalizar — só sai sem assunto.
    let resumo = null;
    if (rota) {
      setEtapa("Gerando o resumo com a IA...");
      try {
        const r = await runtime.api.post(rota, { ticketId: ticketId }, { timeout: 45000 });
        const dados = r && r.data;
        if (dados && !dados.erro && typeof dados.result === "string") resumo = dados.result;
        else setAviso("A IA não gerou o resumo" + (dados && dados.result ? ": " + dados.result : "") + ". O chamado será finalizado sem ele.");
      } catch (e) {
        setAviso("A IA não respondeu (" + mensagemDe(e) + "). O chamado será finalizado sem resumo.");
      }
    }

    try {
      setEtapa("Finalizando o chamado no TomTicket...");
      await props.api.post("/chamado/finalizar", {
        ticketId: ticketId,
        userId: usuarioId,
        comResumo: comResumo,
        resumo: resumo
      });
    } catch (e) {
      setEtapa(null);
      setErro("O chamado não foi finalizado: " + mensagemDe(e) + ". O atendimento continua aberto.");
      return;
    }
    setInfo(Object.assign({}, info, { chamado: Object.assign({}, chamado, { finalizado: true, finalizadoPor: "resolvido" }) }));

    try {
      setEtapa("Resolvendo o atendimento...");
      await runtime.api.put("/tickets/" + ticketId, {
        status: "closed",
        userId: usuarioId || null,
        sendFarewellMessage: false,
        amountUsedBotQueues: 0
      });
    } catch (e) {
      setEtapa(null);
      setErro("O chamado foi finalizado, mas o atendimento não foi resolvido: " + mensagemDe(e) + ". Use o Resolver normal.");
      return;
    }

    setEtapa(null);
    setAberto(false);
    irParaLista();
  }

  const estiloDoBotao = {
    marginRight: 8,
    padding: "2px 10px",
    textTransform: "none",
    whiteSpace: "nowrap",
    fontWeight: 600,
    color: "${COR_TOMTICKET}",
    border: "2px solid ${BORDA_TOMTICKET}",
    borderRadius: 6,
    backgroundColor: "${FUNDO_TOMTICKET}",
    opacity: disponivel ? 1 : 0.5
  };

  return (
    <>
      <Tooltip title={dica}>
        <span>
          <Button
            size="small"
            variant="outlined"
            disabled={!disponivel}
            startIcon={<img src="${LOGO_TOMTICKET}" alt="" width={16} height={16} />}
            style={estiloDoBotao}
            onClick={function () { setErro(null); setAviso(null); setAberto(true); }}
          >
            {rotulo}
          </Button>
        </span>
      </Tooltip>

      <Dialog open={aberto} onClose={function () { if (!ocupado) setAberto(false); }} maxWidth="xs" fullWidth>
        <DialogTitle>
          <Box display="flex" alignItems="center" style={{ gap: 8 }}>
            <img src="${LOGO_TOMTICKET}" alt="" width={22} height={22} />
            <span>Finalizar o chamado {protocolo ? "#" + protocolo : ""} no TomTicket</span>
          </Box>
        </DialogTitle>
        <DialogContent>
          {ocupado ? (
            <Box display="flex" alignItems="center" style={{ gap: 12 }} py={1}>
              <CircularProgress size={20} />
              <Typography variant="body2">{etapa}</Typography>
            </Box>
          ) : (
            <Typography variant="body2">
              {rota
                ? "O resumo do atendimento (gerado pela IA) vai junto na finalização, e o atendimento é resolvido no Markedesk."
                : "O atendimento é resolvido no Markedesk. Nenhum plugin de IA configurado (aba IA do TomTicket): o chamado sai sem resumo e sem assunto."}
            </Typography>
          )}
          {aviso && <Typography variant="caption" display="block" style={{ marginTop: 8, color: "#b26a00" }}>{aviso}</Typography>}
          {erro && <Typography variant="body2" color="error" style={{ marginTop: 8 }}>{erro}</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={function () { setAberto(false); }} disabled={ocupado}>Cancelar</Button>
          <Button onClick={function () { executar(true); }} disabled={ocupado} variant="contained" color="primary">OK</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!avisoDeFundo}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        message={
          <Box display="flex" alignItems="center" style={{ gap: 10 }}>
            <CircularProgress size={16} color="inherit" />
            <span>{avisoDeFundo}</span>
          </Box>
        }
      />
    </>
  );
`;

/**
 * A aba "IA": qual plugin gera o resumo.
 *
 * Lista os plugins da empresa pelo cliente do app (`GET /plugins`, com a
 * sessão de quem está configurando) — `props.api` só alcança este plugin.
 */
export const TELA_DE_IA = `
  const { useState, useEffect } = React;
  const { Box, Typography, TextField, MenuItem, CircularProgress } = props.mui;
  const runtime = props.runtime || (typeof window !== "undefined" ? window.markedeskRuntime : null) || {};

  const [plugins, setPlugins] = useState(null);
  const [erro, setErro] = useState(null);

  useEffect(function () {
    if (!runtime.api) { setErro("Cliente do app indisponível — reabra a tela."); return; }
    runtime.api.get("/plugins")
      .then(function (res) {
        const lista = Array.isArray(res.data) ? res.data : [];
        setPlugins(lista
          .filter(function (p) { return p && p.id && p.id !== props.pluginId; })
          .map(function (p) { return { value: p.id, label: (p.displayName || p.name || p.id) + " (" + p.id + ")" }; }));
      })
      .catch(function () { setErro("Não foi possível listar os plugins."); });
  }, []);

  const valor = props.value || "";
  const opcoes = plugins || [];
  const conhecido = !valor || opcoes.some(function (op) { return op.value === valor; });

  return (
    <Box>
      <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>
        No botão "Finalizar Chamado" e na transferência do atendimento, este plugin gera o resumo.
        Dele sai o "Assunto principal", que vai no texto de finalização do chamado — com ou sem o resumo inteiro.
      </Typography>
      {erro && <Typography variant="caption" color="error">{erro}</Typography>}
      {!plugins && !erro ? (
        <Box p={1}><CircularProgress size={20} /></Box>
      ) : (
        <TextField
          select
          fullWidth
          margin="dense"
          label="Plugin de IA"
          value={valor}
          onChange={function (e) { props.setValue(e.target.value); }}
          helperText="Precisa ter a ação Resumir Ticket (ex.: AI-Tools)."
        >
          <MenuItem value="">(nenhum — finalizar sem resumo)</MenuItem>
          {!conhecido && <MenuItem value={valor}>{valor} (não encontrado)</MenuItem>}
          {opcoes.map(function (op) { return <MenuItem key={op.value} value={op.value}>{op.label}</MenuItem>; })}
        </TextField>
      )}
    </Box>
  );
`;
