/**
 * A aba "Categorias": uma categoria padrão por departamento do TomTicket.
 *
 * Desenhada pelo plugin, e não montada com campos declarativos, porque a
 * escolha é DEPENDENTE: as categorias de cada linha são as daquele
 * departamento. O `select` declarativo busca de um `endpoint` fixo, declarado
 * uma vez no metadata — ele não enxerga o valor de outro campo, então não há
 * como filtrar a lista pelo departamento da linha. A saída prevista para esse
 * caso é o plugin desenhar a própria tela.
 *
 * LIMITAÇÃO ACEITA: JSX-string não tem type-check nem imports. Tudo vem de
 * `props`.
 *
 * ARMADILHA DO HOST: `props.setCampo(nome, valor)` fecha sobre um snapshot de
 * `props.values` tirado no momento da chamada (não é um updater funcional).
 * Chamar `setCampo` DUAS VEZES no mesmo handler faz a segunda sobrescrever a
 * primeira — as duas leem o mesmo `values` desatualizado, e a segunda grava
 * por cima. Confirmado ao vivo em 30/09/2026: era por isso que o setor
 * inicial nunca salvava (o `setCampo("categoriaInicial", "")` logo depois
 * revertia o `setCampo("setorInicial", ...)`). Para atualizar mais de uma
 * chave no mesmo evento, use `props.setValues(objetoInteiro)` — substitui
 * tudo de uma vez, sem essa corrida.
 */
export const TELA_DE_CATEGORIAS = `
  const { useState, useEffect } = React;
  const { Box, Typography, TextField, MenuItem, CircularProgress, Divider } = props.mui;

  // O campo tem \`name\`, então o valor chega pronto em props.value.
  const mapa = props.value || {};
  // O chamado inicial não é deste campo: grava-se por setCampo, que alcança
  // qualquer setting. Mora nesta tela porque depende dos mesmos setores e
  // categorias já carregados aqui.
  const v = props.values || {};

  const [setores, setSetores] = useState(null);
  const [erro, setErro] = useState(null);

  useEffect(function () {
    props.api.get("/opcoes/setores")
      .then(function (res) { setSetores((res.data && res.data.setores) || []); })
      .catch(function () { setErro("Não foi possível carregar os departamentos do TomTicket."); });
  }, []);

  function escolher(departamentoId, categoriaId) {
    const proximo = Object.assign({}, mapa);
    // Apagar a chave em vez de gravar "" mantém a configuração legível:
    // departamento sem categoria simplesmente não aparece.
    if (categoriaId) { proximo[departamentoId] = categoriaId; } else { delete proximo[departamentoId]; }
    props.setValue(proximo);
  }

  if (erro) {
    return <Typography variant="body2" color="error">{erro}</Typography>;
  }

  if (!setores) {
    return (
      <Box p={2} textAlign="center">
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (!setores.length) {
    return (
      <Typography variant="body2" color="textSecondary">
        Nenhum departamento carregado. Salve o token na aba Conexão e reabra esta tela.
      </Typography>
    );
  }

  const departamentoInicial = setores.filter(function (s) { return s.id === v.setorInicial; })[0];

  return (
    <Box>
      <Typography variant="subtitle2" style={{ marginBottom: 4 }}>
        Chamado inicial
      </Typography>
      <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>
        Onde o chamado é aberto quando o atendimento começa, antes de entrar numa fila.
      </Typography>

      <TextField
        select
        fullWidth
        margin="dense"
        label="Departamento inicial"
        value={v.setorInicial || ""}
        onChange={function (e) {
          // As duas chaves num SÓ setValues: setCampo duas vezes seguidas
          // sobrescreveria a primeira (ver nota no topo do arquivo).
          props.setValues(Object.assign({}, v, {
            setorInicial: e.target.value,
            // A categoria pertence ao departamento: mantê-la ao trocar
            // deixaria uma categoria de outro departamento gravada, e o
            // TomTicket recusaria.
            categoriaInicial: ""
          }));
        }}
      >
        {setores.map(function (setor) {
          return <MenuItem key={setor.id} value={setor.id}>{setor.nome}</MenuItem>;
        })}
      </TextField>

      <TextField
        select
        fullWidth
        margin="dense"
        label="Categoria inicial"
        value={v.categoriaInicial || ""}
        disabled={!departamentoInicial}
        helperText={departamentoInicial ? null : "Escolha o departamento inicial primeiro."}
        onChange={function (e) { props.setCampo("categoriaInicial", e.target.value); }}
      >
        <MenuItem value="">(nenhuma)</MenuItem>
        {((departamentoInicial && departamentoInicial.categorias) || []).map(function (categoria) {
          return <MenuItem key={categoria.id} value={categoria.id}>{categoria.nome}</MenuItem>;
        })}
      </TextField>

      <Box mt={3} mb={2}><Divider /></Box>

      <Typography variant="subtitle2" style={{ marginBottom: 4 }}>
        Categoria por departamento
      </Typography>
      <Typography variant="body2" color="textSecondary" style={{ marginBottom: 12 }}>
        A categoria escolhida em cada departamento é a usada ao abrir um chamado naquele departamento.
      </Typography>

      {setores.map(function (setor) {
        const semCategorias = !setor.categorias || !setor.categorias.length;
        return (
          <TextField
            key={setor.id}
            select
            fullWidth
            margin="dense"
            label={setor.nome}
            value={mapa[setor.id] || ""}
            disabled={semCategorias}
            helperText={semCategorias ? "Este departamento não tem categorias no TomTicket." : null}
            onChange={function (e) { escolher(setor.id, e.target.value); }}
          >
            <MenuItem value="">(nenhuma)</MenuItem>
            {(setor.categorias || []).map(function (categoria) {
              return (
                <MenuItem key={categoria.id} value={categoria.id}>
                  {categoria.nome}
                </MenuItem>
              );
            })}
          </TextField>
        );
      })}
    </Box>
  );
`;
