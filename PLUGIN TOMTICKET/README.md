# Plugin TomTicket

Integração do Markedesk-NG com o help desk [TomTicket](https://www.tomticket.com).

Cada atendimento do Markedesk vira um chamado no TomTicket, e o chamado
acompanha o atendimento: muda de setor, ganha atendente e recebe as mensagens
dos dois lados.

## Changelog

O histórico de versões fica em **[CHANGELOG.md](CHANGELOG.md)** — o que mudou
em cada uma e por quê. Daqui para baixo é documentação do que o plugin faz
hoje, que não muda de versão para versão.

## O fluxo

| Evento no Markedesk | O que acontece no TomTicket |
|---|---|
| `ticket:created` | Nada ainda — só registra que o ticket existe |
| primeira mensagem depois da abertura | **Abre o chamado** (conteúdo = a própria mensagem), no setor da fila já atribuída ou no **setor inicial** se ainda não houver fila |
| `ticket:transferred` (primeira fila, antes de qualquer chamado) | Nada — o destino é aplicado quando a primeira mensagem abrir o chamado |
| `ticket:transferred` (primeira fila, chamado já aberto) | **Transfere** o chamado para o setor daquela fila |
| `ticket:transferred` (troca posterior) | Abre um chamado **novo** no setor de destino |
| `ticket:assigned` | Vincula o atendente correspondente ao chamado |
| `ticket:messageReceived` / `ticket:messageSent` | Entra como resposta do **cliente**, do **atendente** ou do **Bot**, conforme quem escreveu (ver 0.1.4), com a mídia anexada; ou abre o chamado, se for a primeira |

**Ticket sem nenhuma mensagem nunca vira chamado.** É a primeira mensagem —
enviada ou recebida, tanto faz — que abre o chamado; um ticket criado e nunca
respondido não gera lixo no TomTicket. Se ela for do cliente, vira o conteúdo
inicial (que o TomTicket sempre atribui ao cliente). Se for do nosso lado, o
chamado abre com um texto neutro e ela entra como resposta, com o autor certo.

O cliente é identificado pelo **email**: o do contato no Markedesk tem que ser o
mesmo do cliente no TomTicket. Contato sem email não gera chamado (fica no log).

### O id do ticket dentro do chamado

Na abertura, o plugin grava o id do ticket do Markedesk num campo personalizado
do chamado — na conta da Marke é o **"protocolo MarkeDesk"**
(`6527583d997faa14b918650d393527e6`). Qual campo usar é escolhido na aba
**Conexão**, e não fica fixo no código: o id é um hash do TomTicket, e recriar o
campo lá geraria outro — o plugin passaria a gravar num campo inexistente, sem
reclamar.

**O campo precisa existir na categoria onde o chamado é aberto.** Na conta da
Marke ele está em 81 categorias, incluindo `Suporte Sistemas > Duvidas`, mas
está ausente nos setores **Coordenação**, **Gestão MPS-BR** e **Suporte
(Instalar Certificado)** — chamado aberto lá nasce sem o protocolo.

### Por que a primeira fila transfere e a segunda abre outro chamado

O ticket nasce sem fila. Quando ele finalmente entra numa, é o mesmo atendimento
chegando ao setor certo — então o chamado só muda de lugar. Uma troca de fila
depois disso é outra coisa: o atendimento anterior já aconteceu, e o histórico
dele pertence ao setor que atendeu. Por isso abre um chamado novo, citando o
anterior.

Na prática o critério é `oldQueueId`: ausente = primeira fila (transfere),
presente = troca (chamado novo).

### O vínculo no banco

O plugin guarda o vínculo ticket→chamado no **banco próprio** (SQLite — ver
`src/db/`), e é só ali. Uma linha da tabela `vinculos`:

| Coluna | O que é |
|---|---|
| `ticket_id` | o atendimento no Markedesk (chave primária) |
| `chamado_id`, `protocolo` | o chamado no TomTicket — id interno e o número que a pessoa cita |
| `departamento_id`, `departamento_pendente` | setor onde está, e para onde ainda não deu para mover |
| `categoria_id` | categoria escolhida pelo de-para da fila |
| `operador_atual` | atendente vinculado agora |
| `cliente_email` | email com que o cliente foi identificado |
| `fila_id` | fila do Markedesk |
| `mensagem` | começo da primeira mensagem (512 caracteres), como referência |
| `canal` | de onde veio: whatsapp, instagram… |
| `finalizado`, `finalizado_por` | se encerrou e por quê |
| `criado_em`, `atualizado_em` | quando abriu e quando mudou pela última vez |

Quem consome de fora usa `GET /vinculos`, que filtra por protocolo, por ticket
e por abertos.

**Até a 0.2.0 isso era dividido com o n8n.** A cada chamado aberto o plugin
postava num webhook que inseria a linha na tabela `comunica`, no Postgres —
porque o PluginStorage não respondia consulta nenhuma. Na 0.3.0 o webhook saiu:
as três informações que só existiam naquele POST (`categoria`, `mensagem`,
`quem`) viraram as colunas `categoria_id`, `mensagem` e `canal`, pela migração
2 do banco.

A tabela `comunica` **para de receber linhas novas** a partir desta versão. Nada
foi apagado dela, e o workflow **Comunica - banco do plugin TomTicket**
continua no n8n com as duas pontas (`comunica/grava` e `comunica/consulta`) —
o plugin é que não chama mais nenhuma. Quem lia aquela tabela para ligar ticket
a chamado precisa migrar para `GET /vinculos`.

### Comportamentos da API do TomTicket confirmados ao vivo (30/09/2026)

Nenhum destes está na documentação — foram descobertos testando contra a conta
real da Marke, e moldam o design do fluxo:

- **`POST /ticket/new` devolve `ticket_id` e `protocol` na RAIZ da resposta**,
  não em `data` como o resto da API. `criarChamadoEObterId` lê esses campos
  direto; só recorre à busca por lista se um dia pararem de vir.
- **`GET /ticket/list` pode não encontrar um chamado recém-criado na primeira
  tentativa** — indexação com atraso, não erro (200 OK com lista vazia,
  reaparece numa tentativa seguinte). O fallback por lista tenta até 3 vezes
  com espera crescente por causa disso.
- **`POST /ticket/transfer` recusa QUALQUER transferência de um chamado sem
  nenhum atendente vinculado ainda** — "not possible to transfer tickets
  without attendants", mesmo só mudando `department_id`. Como a fila
  normalmente é atribuída pelo chatbot antes de um atendente aceitar, isso
  acontece na maioria das primeiras transferências. É por isso que existe
  `VinculoChamado.departamentoPendente`: quando a transferência não pode
  acontecer ainda, o destino fica guardado e `aoAtribuir` tenta de novo quando
  um atendente for vinculado.
- **Transferir LIMPA o atendente do chamado**, mesmo que ele tenha acabado de
  ser vinculado. `transferirComAtendente` sempre revincula depois.
- **`operator_id` no `/ticket/transfer` está quebrado nesta conta** — falha
  sempre, mesmo repetindo o atendente já vinculado. A API tem um endpoint
  separado que funciona de verdade: `vincularAtendente`
  (`/ticket/operator/link`).
- **Vincular em chamado que já tem atendente falha** ("This ticket does not
  allow adding an operator"), seja o mesmo atendente ou outro. A saída,
  confirmada em 01/10/2026: transferir para o **próprio setor atual** limpa o
  atendente sem mexer em setor, categoria nem situação, e aí o vínculo passa.
  `garantirAtendente` faz isso sozinho, e `VinculoChamado.operadorAtual` evita
  a troca quando o atendente já é o certo.
- **`/ticket/reply/operator` em chamado sem atendente é gravado como do
  cliente** (01/10/2026), sem erro. A resposta de atendente sai sempre em nome
  de quem está vinculado; a de cliente, sempre em nome do dono do chamado. Não
  há parâmetro para escolher outro autor.
- **Anexos** vão como `attachment[0]`, `attachment[1]`... no mesmo
  `multipart/form-data`, até 25 MB por requisição (testado com imagem e áudio).
- A API tem **rate limit** (HTTP 429, página HTML do nginx, não JSON) sob
  rajada de chamadas — algumas ações do fluxo (criar, vincular, transferir,
  revincular) disparam várias chamadas em sequência rápida. `chamar()` tenta
  de novo até 3 vezes com espera crescente quando recebe 429.

### Outros limites conhecidos

- A documentação do TomTicket fala em 512 caracteres por resposta, mas a API grava
  pelo menos **20.000** inteiros (testado em 01/10/2026). Acima disso a mensagem
  vai em partes numeradas — "(parte 1/3)" — em vez de cortada.
- Mídia acima de **24 MB** entra só como texto ("[Vídeo (arquivo não anexado —
  ver no Markedesk)]"), porque a API aceita 25 MB pela requisição inteira.
- Atendente do Markedesk sem de-para na aba Atendentes: a mensagem dele sai em
  nome do Bot (fica no log).

## Configuração (Plugins → TomTicket → Configurar)

Quatro abas:

| Aba | O que se informa |
|---|---|
| **Conexão** | Token da API + botão "Testar conexão" |
| **Atendentes** | De-para: atendente do Markedesk → atendente do TomTicket, e o **atendente Bot** das mensagens automáticas |
| **Filas** | De-para: fila do Markedesk → setor do TomTicket |
| **Categorias** | Setor/categoria do **chamado inicial** + uma categoria padrão por setor |

Tudo do lado TomTicket é **escolhido em lista carregada da conta**, nunca
digitado: os ids são hashes de 32 caracteres, e digitar à mão erra sem avisar —
o erro só apareceria quando a ação falhasse no meio de um atendimento.

As listas vêm do token salvo na aba Conexão. **Salve o token primeiro**; antes
disso os seletores das outras abas aparecem vazios (de propósito — um erro ali
deixaria a aba quebrada em vez de vazia).

A categoria é **por setor, não por fila**: é assim que o TomTicket organiza o
assunto, e duas filas que caem no mesmo setor abrem na mesma categoria. Por isso
a aba Categorias lista os setores da conta, cada um com as categorias dele.

Formato do que fica salvo:

```jsonc
{
  "apiToken": "…",
  "atendentes": [{ "usuarioId": "3", "operadorId": "d131226e…" }],
  "filas": [{ "filaId": "7", "departamentoId": "a82e10d1…" }],
  "categoriasPorSetor": { "a82e10d1…": "e50a11e1…" },
  "setorInicial": "a82e10d1…",
  "categoriaInicial": "e50a11e1…"
}
```

Os resolvedores `operadorDoUsuario()` e `destinoDaFila()` (em
`src/config/settings.ts`) são o caminho para consultar esse de-para —
`destinoDaFila()` já compõe fila → setor → categoria.

### Por que a aba Categorias é JSX

O `select` declarativo busca de um `endpoint` fixo, declarado uma vez no
metadata: ele não enxerga o valor de outro campo, então não há como filtrar as
categorias pelo setor escolhido na mesma linha. A saída prevista para escolha
dependente é o plugin desenhar a própria tela — é o que `src/ui/telaDeCategorias.ts`
faz.

JSX-string não passa pelo TypeScript. `npm run check:jsx` transpila as telas com
o mesmo Babel que o app usa, para um erro de sintaxe aparecer aqui e não na tela
do cliente.

## Rodar em desenvolvimento

```bash
npm install
npm run dev          # tsx watch, sobe em http://localhost:3033
npm run typecheck    # tsc --noEmit
```

O plugin sobe **sem credencial**, em modo não-provisionado. Para ficar ativo:
cadastre a URL dele no Markedesk (Plugins → adicionar plugin remoto); o backend
gera a apiKey e a envia por `POST /admin/provision`, e o plugin salva em
`./data/plugin-config.json`.

Depois disso, preencha o **Token da API** em Plugins → TomTicket → Configurar. O
token é gerado no painel do TomTicket, em Configurações → API.

## Conferir que funcionou

```
GET {url-do-plugin}/status
```

Devolve `{ ok: true, departamentos: N }` quando o token está válido, ou o motivo
da falha. É a checagem mais barata — bate em `/department/list`, que não altera
nada.

## Dependência do SDK

`package.json` aponta o `@markedesk/plugin-sdk` por caminho absoluto:

```
file:C:/REPOSITORIO MARKEDESK/markedesk-ng-main/markedesk-ng-main/packages/plugin-sdk
```

Isso existe porque esta pasta está **fora** do monorepo. Duas consequências:

- Em outra máquina, o caminho muda — ajuste antes do `npm install`.
- O `Dockerfile` espera o layout do monorepo (`plugins/plugin-tomticket/`). Para
  buildar a imagem, copie esta pasta para `plugins/plugin-tomticket` no
  monorepo e troque o `file:` para `file:../../packages/plugin-sdk`.

Se o plugin for entrar no repositório de vez, o lugar dele é
`plugins/plugin-tomticket/`, e aí as duas ressalvas acima somem.

## Estrutura

| Arquivo | O que faz |
|---|---|
| `src/identidade.ts` | id, nome e prefixo de log, num lugar só |
| `src/metadata.ts` | o que o plugin oferece: settings, hooks, ficha da loja |
| `src/index.ts` | entrada standalone (um container por empresa) |
| `src/tomticketInstance.ts` | monta o `PluginServer`: hooks e rotas |
| `src/config/settings.ts` | configuração por empresa (memória + PluginStorage) e resolvedores do de-para |
| `src/fluxo/chamados.ts` | o espelhamento do atendimento no chamado (o coração do plugin) |
| `src/diagnostico.ts` | captura dos logs do plugin para a aba Diagnóstico |
| `src/db/banco.ts` | abre o SQLite, aplica as migrações versionadas e reporta o estado |
| `src/db/vinculos.ts` | repositório dos vínculos ticket↔chamado e das transcrições |
| `src/db/eventos.ts` | repositório do diagnóstico (append-only, com poda) |
| `src/db/importar.ts` | traz do PluginStorage o que existia antes da 0.2.0, uma vez só |
| `src/ui/telaDeDiagnostico.ts` | a aba Diagnóstico |
| `src/ui/logoTomTicket.ts` | ícone oficial do TomTicket, embutido |
| `src/fluxo/finalizacao.ts` | assunto principal lido do resumo e texto de finalização do chamado |
| `src/ui/resolverTomTicket.ts` | botão "Finalizar Chamado" (também na transferência e na transcrição) e aba IA |
| `src/fluxo/mensagem.ts` | quem escreveu a mensagem, o texto e o anexo que vão para o chamado |
| `src/ui/telaDeCategorias.ts` | a aba Categorias, desenhada pelo plugin (JSX-string) |
| `src/ui/telaDeDePara.ts` | as abas Atendentes e Filas, escolha por nome dos dois lados |
| `src/tomticket/api.ts` | cliente da API REST do TomTicket v2.0 |
| `scripts/checarJsx.mts` | transpila as telas JSX para pegar erro de sintaxe |
| `scripts/empacotar.mts` | monta o `build-context.tar.gz` para o build no Portainer |

## Publicar

`INSTALACAO.md` tem o passo a passo do Portainer de homologação. Em resumo:
`npm run empacotar` gera o pacote, o Portainer constrói a imagem a partir dele
e um stack sobe o container. Com Docker na máquina, dá para construir e
publicar direto:

```bash
npm run empacotar
docker build -t elianahippler/marke-plugin-tomticket:<versão> - < build-context.tar.gz
docker push elianahippler/marke-plugin-tomticket:<versão>
```

A versão fica em **dois** lugares e os dois precisam subir junto:
`package.json` e `version` em `src/metadata.ts`. O `package.json` nomeia o
pacote; o `metadata.ts` é o que o Markedesk lê no `/health` e mostra na tela de
plugins. Subir só um publica uma imagem que mente a versão.

Antes de publicar:

1. `npm test`, `npm run typecheck` e `npm run check:jsx` limpos;
2. versão subida nos dois arquivos;
3. entrada nova no [CHANGELOG.md](CHANGELOG.md), dizendo o que mudou e **por quê**;
4. se houve migração de schema, subir a imagem num volume com banco da versão
   anterior e confirmar no log que ela aplica só a migração nova e preserva os
   vínculos.

**A tag `latest` é movida à parte, e só quando a versão já rodou em algum
cliente.** Stacks apontadas para `:latest` pegam o que estiver lá no próximo
update, sem ninguém decidir.

## API do TomTicket — o que não é óbvio

- **`ticket_id` é um hash, não o protocolo.** O número que o cliente conhece
  (ex: 74037) é o `protocol`. Para chegar ao chamado a partir dele, use
  `buscarPorProtocolo()` — a API não tem busca por protocolo exato, só a faixa
  `min_protocol`/`max_protocol`, que com os dois iguais devolve o chamado único.
- **Escritas são `multipart/form-data`**, não JSON. Enviar JSON devolve 401 sem
  dizer o motivo.
- **`error: true` chega com HTTP 200** em parte dos casos — checar só o status
  deixa falha passar como sucesso.
- **`current_status` costuma vir nulo**; o status real está em
  `situation.description`.
