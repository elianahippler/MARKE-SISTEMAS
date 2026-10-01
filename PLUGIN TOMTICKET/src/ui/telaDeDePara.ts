/**
 * As abas "Atendentes" e "Filas": o de-para Markedesk → TomTicket, escolhido
 * por NOME dos dois lados. O id do TomTicket (um hash de 32 caracteres) fica só
 * no valor gravado, nunca na tela.
 *
 * Desenhadas pelo plugin, e não com `list` + `select` declarativos, porque o
 * `select` com `endpoint` NÃO carrega dentro de um item de lista: o host monta
 * os campos do item com um contexto sem `routePath` (confirmado em
 * `PluginSettingsForm/index.js`, ListFieldRenderer), e `useEndpointValue` sem
 * `routePath` nem tenta buscar. Era essa, e não o token salvo tarde, a causa
 * do seletor vazio que levou a 0.1.3 a trocar os campos por texto.
 *
 * Os dois lados vêm de rotas do plugin: o do TomTicket da API dele, e o do
 * Markedesk (atendentes, filas) do backend, pelo cliente do SDK — `props.api`
 * só alcança o plugin, não as rotas do Markedesk.
 *
 * LIMITAÇÃO ACEITA: JSX-string não tem type-check nem imports. Tudo vem de
 * `props`. Ícones do conjunto v4 (`@material-ui/icons`).
 *
 * ARMADILHA DO HOST (ver telaDeCategorias.ts): `setCampo` duas vezes no mesmo
 * evento faz a segunda sobrescrever a primeira. Aqui cada handler grava uma
 * chave só.
 */
interface OpcoesDaTela {
  /** Chave, dentro de cada item, do id no Markedesk (`usuarioId`, `filaId`). */
  chaveMarkedesk: string;
  /** Chave, dentro de cada item, do id no TomTicket (`operadorId`, `departamentoId`). */
  chaveTomTicket: string;
  rotaMarkedesk: string;
  rotaTomTicket: string;
  rotuloMarkedesk: string;
  rotuloTomTicket: string;
  textoAdicionar: string;
  explicacao: string;
  /**
   * Seletor extra, fora da lista, que grava um id do TomTicket noutra
   * setting — o atendente Bot.
   */
  avulso?: { campo: string; rotulo: string; ajuda: string; vazio: string };
}

function telaDeDePara(o: OpcoesDaTela): string {
  return `
    const { useState, useEffect, useCallback } = React;
    const { Box, Typography, TextField, MenuItem, IconButton, Button, CircularProgress, Tooltip, Divider } = props.mui;
    const { Refresh, DeleteOutline, Add } = props.icons;

    // O campo tem \`name\`, então a lista chega pronta em props.value.
    const itens = Array.isArray(props.value) ? props.value : [];
    const v = props.values || {};

    const [doMarkedesk, setDoMarkedesk] = useState(null);
    const [doTomTicket, setDoTomTicket] = useState(null);
    const [carregando, setCarregando] = useState(false);
    const [erro, setErro] = useState(null);

    const carregar = useCallback(function () {
      setCarregando(true);
      setErro(null);
      function opcoes(res) { return (res.data && res.data.options) || []; }
      Promise.all([props.api.get("${o.rotaMarkedesk}"), props.api.get("${o.rotaTomTicket}")])
        .then(function (r) { setDoMarkedesk(opcoes(r[0])); setDoTomTicket(opcoes(r[1])); })
        .catch(function () { setErro("Não foi possível carregar as listas."); })
        .finally(function () { setCarregando(false); });
    }, []);

    useEffect(function () { carregar(); }, [carregar]);

    function alterar(indice, chave, valor) {
      props.setValue(itens.map(function (item, i) {
        if (i !== indice) return item;
        const proximo = Object.assign({}, item);
        proximo[chave] = valor;
        return proximo;
      }));
    }

    function remover(indice) {
      props.setValue(itens.filter(function (_, i) { return i !== indice; }));
    }

    function adicionar() {
      props.setValue(itens.concat([{}]));
    }

    // Um id gravado que não está mais na lista (apagado lá, ou lista que não
    // carregou) continua aparecendo — sem isto o select mostraria vazio e o
    // próximo Salvar pareceria ter perdido o vínculo.
    function comOrfao(opcoes, valor) {
      const lista = opcoes || [];
      if (!valor) return lista;
      const existe = lista.some(function (op) { return String(op.value) === String(valor); });
      return existe ? lista : lista.concat([{ value: valor, label: "(não encontrado na lista atual)" }]);
    }

    function seletor(rotulo, opcoes, valor, aoMudar, extra) {
      return (
        <TextField
          select
          fullWidth
          margin="dense"
          label={rotulo}
          value={valor == null ? "" : String(valor)}
          onChange={function (e) { aoMudar(e.target.value); }}
          disabled={!opcoes}
        >
          {extra}
          {comOrfao(opcoes, valor).map(function (op) {
            return <MenuItem key={op.value} value={String(op.value)}>{op.label}</MenuItem>;
          })}
        </TextField>
      );
    }

    return (
      <Box>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="body2" color="textSecondary">${o.explicacao}</Typography>
          <Tooltip title="Recarregar listas">
            <span>
              <IconButton size="small" onClick={carregar} disabled={carregando}>
                {carregando ? <CircularProgress size={16} /> : <Refresh fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        </Box>

        {erro && <Typography variant="caption" color="error">{erro}</Typography>}
        {!erro && doTomTicket && !doTomTicket.length && (
          <Typography variant="caption" color="error">
            Lista do TomTicket vazia — confira o token salvo na aba Conexão e clique em recarregar.
          </Typography>
        )}

        {itens.map(function (item, indice) {
          return (
            <Box key={indice} display="flex" alignItems="center" style={{ gap: 8 }}>
              <Box flex={1}>
                {seletor("${o.rotuloMarkedesk}", doMarkedesk, item.${o.chaveMarkedesk}, function (valor) {
                  alterar(indice, "${o.chaveMarkedesk}", valor);
                })}
              </Box>
              <Box flex={1}>
                {seletor("${o.rotuloTomTicket}", doTomTicket, item.${o.chaveTomTicket}, function (valor) {
                  alterar(indice, "${o.chaveTomTicket}", valor);
                })}
              </Box>
              <Tooltip title="Remover">
                <IconButton size="small" color="secondary" onClick={function () { remover(indice); }}>
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          );
        })}

        <Button size="small" variant="outlined" startIcon={<Add />} onClick={adicionar} style={{ marginTop: 8 }}>
          ${o.textoAdicionar}
        </Button>
        ${
          o.avulso
            ? `
        <Box mt={3} mb={1}><Divider /></Box>
        {seletor("${o.avulso.rotulo}", doTomTicket, v.${o.avulso.campo}, function (valor) {
          props.setCampo("${o.avulso.campo}", valor);
        }, <MenuItem value="">${o.avulso.vazio}</MenuItem>)}
        <Typography variant="caption" color="textSecondary">${o.avulso.ajuda}</Typography>`
            : ""
        }
      </Box>
    );
  `;
}

export const TELA_DE_ATENDENTES = telaDeDePara({
  chaveMarkedesk: "usuarioId",
  chaveTomTicket: "operadorId",
  rotaMarkedesk: "/opcoes/usuarios-markedesk",
  rotaTomTicket: "/opcoes/atendentes",
  rotuloMarkedesk: "Atendente no Markedesk",
  rotuloTomTicket: "Atendente no TomTicket",
  textoAdicionar: "Adicionar atendente",
  explicacao: "Quem atende no Markedesk e quem é essa pessoa no TomTicket.",
  avulso: {
    campo: "operadorBotId",
    rotulo: "Atendente Bot no TomTicket",
    vazio: "(nenhum)",
    ajuda:
      "Assina menu, saudação, transferência e demais mensagens automáticas. " +
      "Sem ele, essas mensagens entram como comentário interno no chamado."
  }
});

export const TELA_DE_FILAS = telaDeDePara({
  chaveMarkedesk: "filaId",
  chaveTomTicket: "departamentoId",
  rotaMarkedesk: "/opcoes/filas-markedesk",
  rotaTomTicket: "/opcoes/departamentos",
  rotuloMarkedesk: "Fila no Markedesk",
  rotuloTomTicket: "Departamento no TomTicket",
  textoAdicionar: "Adicionar fila",
  explicacao: "Para qual departamento do TomTicket vai o chamado de cada fila."
});
