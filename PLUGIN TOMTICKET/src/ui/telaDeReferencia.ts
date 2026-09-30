/**
 * Bloco de referência (só leitura): lista "nome → ID" do TomTicket, com botão
 * de recarregar e de copiar cada ID.
 *
 * Existe porque os campos de escolha dependentes de `endpoint` só buscam uma
 * vez, no momento em que a aba é montada — se ela foi aberta antes do token
 * estar salvo, fica vazia até fechar e reabrir o modal inteiro (limitação do
 * host, não do plugin: confirmado lendo `PluginSettingsForm`, não há como o
 * campo saber que o token mudou depois de montado).
 *
 * Por isso os campos "Atendente no TomTicket" e "Departamento no TomTicket"
 * viraram texto livre — e este bloco dá a lista para copiar, com um botão que
 * refaz a busca sem precisar fechar nada.
 *
 * LIMITAÇÃO ACEITA: JSX-string não tem type-check nem imports. Tudo vem de
 * `props`. Ícones do conjunto v4 (`@material-ui/icons`), que é o que o host
 * injeta em `props.icons` — `ContentCopy` é nome da v5 e não existe aqui;
 * o equivalente é `FileCopy`.
 */
function blocoDeReferencia(endpoint: string, titulo: string): string {
  return `
    const { useState, useEffect, useCallback } = React;
    const { Box, Typography, IconButton, CircularProgress, Tooltip } = props.mui;
    const { Refresh, FileCopy } = props.icons;

    const [itens, setItens] = useState(null);
    const [carregando, setCarregando] = useState(false);
    const [erro, setErro] = useState(null);
    const [copiadoId, setCopiadoId] = useState(null);

    const carregar = useCallback(function () {
      setCarregando(true);
      setErro(null);
      props.api.get("${endpoint}")
        .then(function (res) { setItens((res.data && res.data.options) || []); })
        .catch(function () { setErro("Não foi possível carregar."); })
        .finally(function () { setCarregando(false); });
    }, []);

    useEffect(function () { carregar(); }, [carregar]);

    function copiar(valor) {
      try {
        navigator.clipboard.writeText(valor);
        setCopiadoId(valor);
        setTimeout(function () { setCopiadoId(null); }, 1500);
      } catch (e) { /* clipboard indisponível — o ID continua visível para copiar à mão */ }
    }

    return (
      <Box mb={2} p={1.5} style={{ background: "rgba(127,127,127,0.08)", borderRadius: 4 }}>
        <Box display="flex" alignItems="center" justifyContent="space-between" mb={itens && itens.length ? 1 : 0}>
          <Typography variant="subtitle2">${titulo}</Typography>
          <Tooltip title="Recarregar">
            <span>
              <IconButton size="small" onClick={carregar} disabled={carregando}>
                {carregando ? <CircularProgress size={16} /> : <Refresh fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        </Box>

        {erro && <Typography variant="caption" color="error">{erro}</Typography>}

        {!erro && !carregando && itens && !itens.length && (
          <Typography variant="caption" color="textSecondary">
            Nenhum resultado — confira o token salvo na aba Conexão.
          </Typography>
        )}

        {!erro && (itens || []).map(function (item) {
          return (
            <Box key={item.value} display="flex" alignItems="center" justifyContent="space-between" py={0.25}>
              <Typography variant="body2">{item.label}</Typography>
              <Box display="flex" alignItems="center" style={{ gap: 4 }}>
                <Typography variant="caption" style={{ fontFamily: "monospace" }}>
                  {copiadoId === item.value ? "copiado!" : item.value}
                </Typography>
                <Tooltip title="Copiar ID">
                  <IconButton size="small" onClick={function () { copiar(item.value); }}>
                    <FileCopy fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  `;
}

export const REFERENCIA_ATENDENTES = blocoDeReferencia(
  "/opcoes/atendentes",
  "Atendentes no TomTicket — clique no ícone para copiar o ID"
);

export const REFERENCIA_DEPARTAMENTOS = blocoDeReferencia(
  "/opcoes/departamentos",
  "Departamentos no TomTicket — clique no ícone para copiar o ID"
);
