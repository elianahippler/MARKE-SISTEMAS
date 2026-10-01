/**
 * O botão "Resolver + TomTicket" e a aba "IA" da configuração.
 *
 * POR QUE UM BOTÃO, e não uma 3ª opção no diálogo "Resolver": os botões desse
 * diálogo são fixos no core (TicketActionButtonsCustom), sem ponto para plugin
 * acrescentar opção. E interceptar `resolve-ticket` não serve: o "Resolver" do
 * cabeçalho chama `PUT /tickets/:id` direto, sem passar pelo interceptador (só
 * o resolver da LISTA de tickets passa). O slot `ticket-header` põe o botão ao
 * lado do "Resolver", que é onde a pessoa procura.
 *
 * A ordem do fluxo importa: resumo → finaliza o chamado → resolve o
 * atendimento. O atendimento só é resolvido se o chamado foi finalizado; ao
 * contrário, uma falha deixaria o atendimento fechado e o chamado pendurado.
 * Resolve SEM mensagem de despedida: a despedida chegaria ao plugin depois de
 * o chamado já estar finalizado.
 *
 * LIMITAÇÃO ACEITA: JSX-string não tem type-check nem imports. Tudo vem de
 * `props` — `props.runtime.api` é o cliente do app, com a sessão de quem
 * clicou; `props.api` é o mesmo, já apontado para as rotas deste plugin.
 */

export const BOTAO_RESOLVER = `
  const { useState, useEffect } = React;
  const { Button, Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress, Typography, Box } = props.mui;
  const runtime = props.runtime || {};
  const ticketId = props.context && props.context.ticketId;

  const [info, setInfo] = useState(null);
  const [aberto, setAberto] = useState(false);
  const [etapa, setEtapa] = useState(null);
  const [erro, setErro] = useState(null);
  const [aviso, setAviso] = useState(null);

  useEffect(function () {
    let vivo = true;
    setInfo(null);
    if (!ticketId) return undefined;
    props.api.get("/chamado?ticketId=" + ticketId)
      .then(function (res) { if (vivo) setInfo(res.data || null); })
      .catch(function () { if (vivo) setInfo(null); });
    return function () { vivo = false; };
  }, [ticketId]);

  // Sem chamado aberto não há o que finalizar: o botão nem aparece.
  if (!info || !info.chamado || info.chamado.finalizado) return null;

  const protocolo = info.chamado.protocolo;
  const ocupado = !!etapa;

  // O plugin de IA mora na mesma empresa: troca só o id no fim do caminho
  // (/p/{hash}/{pluginId}).
  function rotaDaIa() {
    if (!info.pluginIaId || !props.routePath) return null;
    return props.routePath.replace(/\\/[^\\/]+$/, "/" + info.pluginIaId);
  }

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
    const rota = rotaDaIa();
    if (rota) {
      setEtapa("Gerando o resumo com a IA...");
      try {
        const r = await runtime.api.post(rota + "/acoes/resumir", { ticketId: ticketId });
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

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        color="primary"
        style={{ marginRight: 8, textTransform: "none", whiteSpace: "nowrap" }}
        onClick={function () { setErro(null); setAviso(null); setAberto(true); }}
      >
        Resolver + TomTicket
      </Button>

      <Dialog open={aberto} onClose={function () { if (!ocupado) setAberto(false); }} maxWidth="xs" fullWidth>
        <DialogTitle>Resolver e finalizar o chamado {protocolo ? "#" + protocolo : ""} no TomTicket</DialogTitle>
        <DialogContent>
          {ocupado ? (
            <Box display="flex" alignItems="center" style={{ gap: 12 }} py={1}>
              <CircularProgress size={20} />
              <Typography variant="body2">{etapa}</Typography>
            </Box>
          ) : (
            <Typography variant="body1">Adicionar Resumo do Ticket?</Typography>
          )}
          {!rotaDaIa() && !ocupado && (
            <Typography variant="caption" color="textSecondary" display="block" style={{ marginTop: 8 }}>
              Nenhum plugin de IA configurado (aba IA do TomTicket): o chamado será finalizado sem resumo e sem assunto.
            </Typography>
          )}
          {aviso && <Typography variant="caption" display="block" style={{ marginTop: 8, color: "#b26a00" }}>{aviso}</Typography>}
          {erro && <Typography variant="body2" color="error" style={{ marginTop: 8 }}>{erro}</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={function () { setAberto(false); }} disabled={ocupado}>Cancelar</Button>
          <Button onClick={function () { executar(false); }} disabled={ocupado} variant="outlined" color="primary">Não</Button>
          <Button onClick={function () { executar(true); }} disabled={ocupado || !rotaDaIa()} variant="contained" color="primary">Sim</Button>
        </DialogActions>
      </Dialog>
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
        No botão "Resolver + TomTicket", este plugin gera o resumo do atendimento. Dele sai o
        "Assunto principal", que vai no texto de finalização do chamado — com ou sem o resumo inteiro.
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
