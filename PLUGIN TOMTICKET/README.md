# Plugin TomTicket

Integração do Markedesk-NG com o help desk [TomTicket](https://www.tomticket.com).

Cada atendimento do Markedesk vira um chamado no TomTicket, e o chamado
acompanha o atendimento: muda de setor, ganha atendente e recebe as mensagens
dos dois lados.

## 0.1.3 — atendentes e departamentos viram texto + referência (30/09/2026)

O `select` dependente de `endpoint` (usado em "Atendente no TomTicket" e
"Departamento no TomTicket") só busca uma vez, no mount da aba — mesma raiz do
problema já corrigido no `/testar`, mas esta parte não dava pra resolver só com
persistência: mesmo com o token salvo, quem abre a aba Atendentes ANTES de
revisitar a aba Conexão ainda vê o campo vazio, porque o componente já montou
e já buscou (vazio) antes.

Em vez de insistir no seletor, os dois campos viraram **texto livre**, e cada
aba (Atendentes, Filas) ganhou um **bloco de referência** no topo — lista
"nome → ID" do TomTicket, com botão de recarregar e de copiar o ID, desenhado
pelo plugin (`src/ui/telaDeReferencia.ts`). Esse bloco tem seu próprio fetch, e
o botão de recarregar destrava sem precisar fechar o modal.

Corrigido de quebra: `scripts/empacotar.mts` estava incluindo a própria pasta
`releases/` (com os `.tar.gz` de versões anteriores) dentro de cada pacote
novo — cada versão ia carregando todas as anteriores, crescendo sem parar
(pego ao ver o pacote da 0.1.3 com 0.78 MB, o dobro do esperado). Também parou
de incluir o backup pontual de workflow do n8n.

## 0.1.2 — correções (30/09/2026)

Feedback de uso real na tela de configuração, em produção:

1. **"Testar conexão" agora salva.** Antes, só testava — era preciso clicar
   em Salvar e fechar/reabrir o modal para as abas Atendentes/Filas/Categorias
   pararem de aparecer vazias (elas dependem do token, carregado só uma vez ao
   montar). Testar com sucesso já persiste o token na hora.
2. **Chamado inicial não salvava a escolha.** Bug real no JSX da aba
   Categorias: o campo "Setor inicial" chamava `setCampo` duas vezes seguidas
   no mesmo evento (setor + limpar categoria), e a segunda sobrescrevia a
   primeira — armadilha do host, documentada no topo de `telaDeCategorias.ts`.
   Corrigido com `setValues` (atualização atômica).
3. **Nomenclatura "setor" → "departamento"** nos rótulos da tela, para bater
   com o termo que o TomTicket usa.
4. **Chamado só nasce na primeira mensagem, não no `ticket:created`.** Ticket
   aberto e nunca respondido não gera chamado — ver seção "O fluxo" abaixo.
5. Atendentes/Filas aparecerem vazios na prática era o mesmo problema do
   item 1 (token não persistido a tempo) — resolvido pela mesma correção.
   **Limitação à parte, não corrigível pelo plugin:** o `required: true`
   desses campos é só cosmético nesta versão do Markedesk (mostra o asterisco,
   não bloqueia salvar com o campo vazio) — conferido em
   `PluginSettingsForm/index.js` e `Plugins/index.js`, não há validação
   bloqueante em nenhum tipo de campo. Entrada incompleta não quebra nada (os
   resolvedores do plugin ignoram silenciosamente o que está incompleto), mas
   também não impede salvar assim.

## O fluxo

| Evento no Markedesk | O que acontece no TomTicket |
|---|---|
| `ticket:created` | Nada ainda — só registra que o ticket existe |
| primeira mensagem depois da abertura | **Abre o chamado** (conteúdo = a própria mensagem), no setor da fila já atribuída ou no **setor inicial** se ainda não houver fila |
| `ticket:transferred` (primeira fila, antes de qualquer chamado) | Nada — o destino é aplicado quando a primeira mensagem abrir o chamado |
| `ticket:transferred` (primeira fila, chamado já aberto) | **Transfere** o chamado para o setor daquela fila |
| `ticket:transferred` (troca posterior) | Abre um chamado **novo** no setor de destino |
| `ticket:assigned` | Vincula o atendente correspondente ao chamado |
| `ticket:messageReceived` | Entra como resposta **do cliente** (ou abre o chamado, se for a primeira) |
| `ticket:messageSent` | Entra como resposta **do atendente** (ou abre o chamado, se for a primeira) |

**Ticket sem nenhuma mensagem nunca vira chamado.** É a primeira mensagem —
enviada ou recebida, tanto faz — que abre o chamado; um ticket criado e nunca
respondido não gera lixo no TomTicket.

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

### O vínculo no banco (n8n)

O plugin guarda o vínculo ticket→chamado no PluginStorage para uso próprio. Além
disso, a cada chamado aberto ele posta no webhook do n8n configurado na aba
**Conexão**, que insere a linha na tabela `comunica`:

```json
{
  "markedesk": "1234",
  "tomticket": "c40ff726…",
  "protocolo": "74037",
  "email": "cliente@exemplo.com",
  "tipo": "E",
  "departamento": "a82e10d1…",
  "categoria": "e50a11e1…",
  "mensagem": "…",
  "quem": "whatsapp"
}
```

O banco existe para o que está **fora** do plugin — fluxos do n8n e relatórios
que precisam ligar um ticket a um chamado. Por isso a gravação é best-effort:
falhar ali não interrompe o atendimento, que já está de pé. Campo vazio na
configuração desliga a gravação.

Workflow que recebe: **Plugin TomTicket - grava vinculo** (`hZgMml6NAICFRgzM`).

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
- **Vincular o mesmo atendente duas vezes seguidas falha** ("does not allow
  adding an operator") — por isso `transferirComAtendente` aceita um flag
  `jaVinculado` para pular a chamada redundante quando o chamador acabou de
  vincular.
- A API tem **rate limit** (HTTP 429, página HTML do nginx, não JSON) sob
  rajada de chamadas — algumas ações do fluxo (criar, vincular, transferir,
  revincular) disparam várias chamadas em sequência rápida. `chamar()` tenta
  de novo até 3 vezes com espera crescente quando recebe 429.

### Outros limites conhecidos

- Mensagem é cortada em **512 caracteres** (limite da API do TomTicket).
- Mídia sem legenda entra como `[image]`, `[audio]`, etc. — o arquivo em si não
  é enviado ao chamado.

## Configuração (Plugins → TomTicket → Configurar)

Quatro abas:

| Aba | O que se informa |
|---|---|
| **Conexão** | Token da API + botão "Testar conexão" |
| **Atendentes** | De-para: atendente do Markedesk → atendente do TomTicket |
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
file:C:/markedesk-ng-main/markedesk-ng-main/packages/plugin-sdk
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
| `src/ui/telaDeCategorias.ts` | a aba Categorias, desenhada pelo plugin (JSX-string) |
| `src/tomticket/api.ts` | cliente da API REST do TomTicket v2.0 |
| `scripts/checarJsx.mts` | transpila as telas JSX para pegar erro de sintaxe |
| `scripts/empacotar.mts` | monta o `build-context.tar.gz` para o build no Portainer |

## Publicar

`INSTALACAO.md` tem o passo a passo do Portainer de homologação. Em resumo:
`npm run empacotar` gera o pacote, o Portainer constrói a imagem a partir dele
(não há Docker na máquina de desenvolvimento) e um stack sobe o container.

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
