/**
 * A aba "Diagnóstico": os últimos erros, avisos e chamados do plugin.
 *
 * Existe para responder "por que este atendimento não virou chamado?" sem
 * abrir os logs do container no Portainer — o motivo mais comum ("sem email
 * no contato", "fila não mapeada") aparece aqui com data e hora.
 *
 * LIMITAÇÃO ACEITA: JSX-string não tem type-check nem imports. Tudo vem de
 * `props`.
 */
export const TELA_DE_DIAGNOSTICO = `
  const { useState, useEffect, useCallback } = React;
  const { Box, Typography, IconButton, CircularProgress, Tooltip, Chip, Divider } = props.mui;
  const { Refresh } = props.icons;

  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);
  const [filtro, setFiltro] = useState("problemas");

  const carregar = useCallback(function () {
    setCarregando(true);
    setErro(null);
    props.api.get("/diagnostico")
      .then(function (res) { setDados(res.data || { eventos: [] }); })
      .catch(function () { setErro("Não foi possível carregar o diagnóstico."); })
      .finally(function () { setCarregando(false); });
  }, []);

  useEffect(function () { carregar(); }, [carregar]);

  function quando(iso) {
    try { return new Date(iso).toLocaleString("pt-BR"); } catch (e) { return iso; }
  }

  // "Chamados" são as linhas de abertura e finalização; o resto informativo
  // (vínculo de atendente, transferência) fica em "Tudo".
  function ehChamado(ev) { return /→ chamado|finalizado pelo ticket/.test(ev.texto); }

  const todos = (dados && dados.eventos) || [];
  const visiveis = todos.filter(function (ev) {
    if (filtro === "problemas") return ev.nivel !== "info";
    if (filtro === "chamados") return ehChamado(ev);
    return true;
  });
  const qtdProblemas = todos.filter(function (ev) { return ev.nivel !== "info"; }).length;
  const qtdChamados = todos.filter(ehChamado).length;

  const cor = { erro: "#d32f2f", aviso: "#ed6c02", info: "inherit" };
  const rotulo = { erro: "ERRO", aviso: "AVISO", info: "INFO" };

  return (
    <Box>
      <Box display="flex" alignItems="center" justifyContent="space-between">
        <Box display="flex" style={{ gap: 6 }}>
          <Chip size="small" label={"Erros e avisos (" + qtdProblemas + ")"} color={filtro === "problemas" ? "primary" : "default"} onClick={function () { setFiltro("problemas"); }} />
          <Chip size="small" label={"Chamados (" + qtdChamados + ")"} color={filtro === "chamados" ? "primary" : "default"} onClick={function () { setFiltro("chamados"); }} />
          <Chip size="small" label={"Tudo (" + todos.length + ")"} color={filtro === "tudo" ? "primary" : "default"} onClick={function () { setFiltro("tudo"); }} />
        </Box>
        <Tooltip title="Atualizar">
          <span>
            <IconButton size="small" onClick={carregar} disabled={carregando}>
              {carregando ? <CircularProgress size={16} /> : <Refresh fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Typography variant="caption" color="textSecondary" display="block" style={{ margin: "6px 0 8px" }}>
        Últimos 200 registros do plugin, mais recentes primeiro{dados && dados.desde ? " — plugin no ar desde " + quando(dados.desde) : ""}.
      </Typography>

      {erro && <Typography variant="body2" color="error">{erro}</Typography>}
      {!erro && dados && !visiveis.length && (
        <Typography variant="body2" color="textSecondary">Nada por aqui.</Typography>
      )}

      <Box style={{ maxHeight: 420, overflowY: "auto" }}>
        {visiveis.map(function (ev, i) {
          return (
            <Box key={i} py={0.75}>
              <Typography variant="caption" color="textSecondary">
                {quando(ev.quando)} · <span style={{ color: cor[ev.nivel], fontWeight: 600 }}>{rotulo[ev.nivel]}</span>
              </Typography>
              <Typography variant="body2" style={{ wordBreak: "break-word" }}>{ev.texto}</Typography>
              <Divider style={{ marginTop: 6 }} />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
`;
