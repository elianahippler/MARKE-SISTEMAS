/**
 * A aba "Diagnóstico": os últimos erros, avisos e chamados do plugin.
 *
 * Existe para responder "por que este atendimento não virou chamado?" sem
 * abrir os logs do container no Portainer — o motivo mais comum ("sem email
 * no contato", "fila não mapeada") aparece aqui com data e hora.
 *
 * ## O que mudou com o banco próprio
 *
 * O filtro passou a ser DO SERVIDOR. Antes a tela baixava 200 eventos e
 * filtrava em memória, então "Erros e avisos (3)" contava 3 entre os 200 que
 * tinham vindo — não entre os que existem. Agora a contagem vem de
 * `COUNT(*)` e trocar de aba refaz a consulta.
 *
 * Saiu daqui também a expressão regular que decidia o que era "linha de
 * chamado": isso agora é uma coluna, calculada na gravação (ver
 * `db/eventos.ts`). Era a mesma pergunta respondida em dois lugares.
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

  // O filtro entra na consulta, então ele é dependência: trocar de aba refaz
  // o fetch em vez de recortar o que já estava na tela.
  const carregar = useCallback(function (qual) {
    setCarregando(true);
    setErro(null);
    props.api.get("/diagnostico?filtro=" + encodeURIComponent(qual))
      .then(function (res) { setDados(res.data || { eventos: [] }); })
      .catch(function () { setErro("Não foi possível carregar o diagnóstico."); })
      .finally(function () { setCarregando(false); });
  }, []);

  useEffect(function () { carregar(filtro); }, [carregar, filtro]);

  function quando(iso) {
    try { return new Date(iso).toLocaleString("pt-BR"); } catch (e) { return iso; }
  }

  function tamanho(bytes) {
    if (!bytes) return "0 KB";
    if (bytes < 1048576) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  const eventos = (dados && dados.eventos) || [];
  // As contagens vêm do banco. Se o backend for antigo e não mandar, cai para
  // o que está na tela — mostrar nada seria pior que mostrar o parcial.
  const contagens = (dados && dados.contagens) || {
    problemas: eventos.length, chamados: 0, tudo: eventos.length
  };
  const banco = dados && dados.banco;

  const cor = { erro: "#d32f2f", aviso: "#ed6c02", info: "inherit" };
  const rotulo = { erro: "ERRO", aviso: "AVISO", info: "INFO" };

  function aba(id, texto, total) {
    return (
      <Chip
        size="small"
        label={texto + " (" + total + ")"}
        color={filtro === id ? "primary" : "default"}
        onClick={function () { setFiltro(id); }}
      />
    );
  }

  return (
    <Box>
      <Box display="flex" alignItems="center" justifyContent="space-between">
        <Box display="flex" style={{ gap: 6 }}>
          {aba("problemas", "Erros e avisos", contagens.problemas)}
          {aba("chamados", "Chamados", contagens.chamados)}
          {aba("tudo", "Tudo", contagens.tudo)}
        </Box>
        <Tooltip title="Atualizar">
          <span>
            <IconButton size="small" onClick={function () { carregar(filtro); }} disabled={carregando}>
              {carregando ? <CircularProgress size={16} /> : <Refresh fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Typography variant="caption" color="textSecondary" display="block" style={{ margin: "6px 0 8px" }}>
        {eventos.length} registro(s) nesta lista, mais recentes primeiro{dados && dados.desde ? " — plugin no ar desde " + quando(dados.desde) : ""}.
      </Typography>

      {erro && <Typography variant="body2" color="error">{erro}</Typography>}
      {!erro && dados && !eventos.length && (
        <Typography variant="body2" color="textSecondary">Nada por aqui.</Typography>
      )}

      <Box style={{ maxHeight: 420, overflowY: "auto" }}>
        {eventos.map(function (ev, i) {
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

      {/* O estado do banco do plugin. Vale a linha porque é a primeira coisa a
          conferir quando "o plugin perdeu os chamados": se o número de vínculos
          está em zero logo depois de um deploy, o volume não subiu montado. */}
      {banco && (
        <Box mt={1} pt={1} style={{ borderTop: "1px solid rgba(0,0,0,0.08)" }}>
          <Typography variant="caption" color="textSecondary" display="block">
            Banco do plugin (SQLite): {banco.vinculos} vínculo(s), {banco.abertos} em aberto · {banco.eventos} evento(s) · {tamanho(banco.tamanhoBytes)} · schema v{banco.versaoSchema}
          </Typography>
          <Typography variant="caption" color="textSecondary" display="block" style={{ wordBreak: "break-all", opacity: 0.7 }}>
            {banco.caminho}
          </Typography>
        </Box>
      )}
    </Box>
  );
`;
