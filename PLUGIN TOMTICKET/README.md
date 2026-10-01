# Plugin TomTicket

Integração do Markedesk-NG com o help desk [TomTicket](https://www.tomticket.com).

Cada atendimento do Markedesk vira um chamado no TomTicket, e o chamado
acompanha o atendimento: muda de setor, ganha atendente e recebe as mensagens
dos dois lados.

## 0.1.8 — "Finalizar Chamado", transferência e transcrição (01/10/2026)

**Botão "Finalizar Chamado (#protocolo) TomTicket".** É o antigo "Resolver +
TomTicket", com novo nome, contorno laranja suave e borda de 2px. Agora ele
**fica sempre visível**: sem chamado aberto, aparece desabilitado e mostra o
motivo ao passar o mouse. O bug de "às vezes não aparece" vinha da consulta ao
chamado, feita uma vez só, ao abrir o ticket. Quando o chamado nascia depois,
na primeira mensagem, o botão ficava escondido. Agora a consulta se repete a
cada 10 s enquanto o ticket está na tela.

**Transferência finaliza o chamado, com resumo.** Ao transferir pela tela, o
botão, antes de a transferência sair, gera o resumo pela IA e finaliza o
chamado com "Atendimento transferido no Markedesk…", o assunto principal e o
resumo. Isso precisa ser feito na tela porque o AI-Tools lê as mensagens com o
login de quem clicou; pelo servidor, sem usuário, o resumo sairia vazio. A
transferência pode demorar alguns segundos a mais, com um aviso embaixo.
O servidor faz o resto:
- troca de fila sem passar pela tela (fluxo, bot, API): finaliza sem resumo;
- troca de fila: abre o chamado novo no setor de destino;
- troca só de atendente: o chamado novo abre na próxima mensagem, de qualquer
  lado.

**Transcrição de áudio no chamado.** Quando alguém clica em "Transcrever" num
áudio, o texto entra no chamado como **comentário interno** "🎙️ Áudio
transcrito por inteligência artificial: …". Não entra como resposta: não foi
ninguém que escreveu, e resposta de atendente iria por email ao cliente. Os
avisos de falha do Markedesk ("Conversão pra texto falhou" etc.) são
ignorados, e o mesmo áudio não entra duas vezes. O backend não avisa os
plugins quando transcreve; quem percebe a transcrição é o botão, ao escutar a
resposta da tela.

**Assunto do chamado:** `Chamado Recebido | Origem: Markedesk | Ticket #<id do ticket>`.

**Fora desta versão: botão de categoria.** A API do TomTicket não troca a
categoria de um chamado já aberto (testado em 01/10/2026 no chamado 74127):
- as rotas de categoria dão 404;
- `/ticket/transfer` aceita `category_id` (e variantes), mas ignora;
- `/ticket/finish` também ignora.

Fica dependendo de pedido ao TomTicket.

Testado ao vivo nos chamados 74128 a 74130. O 74128 foi finalizado pelo
servidor na troca de fila e o 74129 foi aberto no setor novo. Já o 74129 foi
finalizado pelo caminho da tela, com assunto e resumo, e o 74130 abriu em
seguida. O evento repetido não abriu um quarto chamado.

## 0.1.7 — notas internas, tempo trabalhado, diagnóstico e ícone (01/10/2026)

**Notas internas nunca viram resposta visível.** Foi verificado no backend
4.10.4 em produção: a nota privada não dispara `message:sent` /
`ticket:messageSent` (ela tem evento próprio, `note:created`). Hoje ela não
chega ao plugin. Mesmo assim, se um dia chegar uma mensagem com `isPrivate`,
ela entra como **comentário interno** ("📝 Nota interna (Fulano): …") e nunca
abre chamado. Assim, uma mudança no core não expõe o recado ao cliente.

**Tempo trabalhado na finalização.** O "Resolver + TomTicket" envia
`time_work`, em minutos, contados da abertura do chamado (`creation_date` do
próprio TomTicket) até a finalização. O TomTicket guarda em segundos: 1 minuto
aparece como `work_time: 60`. Isso foi testado no chamado 74122.

**Aba Diagnóstico.** Mostra os últimos 200 registros do plugin, com filtros
"Erros e avisos", "Chamados" e "Tudo". O plugin captura no `console` as linhas
com prefixo `[TomTicket]` (`src/diagnostico.ts`); assim qualquer log novo entra
sem precisar registrar ponto a ponto. Os registros ficam no PluginStorage, com
espera de 5 s entre gravações, e sobrevivem ao restart de cada atualização.

**Ícone.** O card do plugin no Markedesk só aceita símbolos de um mapa fechado,
sem imagem. Agora usa "Chat" na cor da marca (`#F76045`). O logo oficial
(favicon de tomticket.com, embutido em `src/ui/logoTomTicket.ts`) aparece no
botão "Resolver + TomTicket" e no diálogo dele.

Corrigido também: o ícone da aba IA era "SmartToy", que não existe no
Material-UI v4 usado pelas abas. Agora é "Android".

## 0.1.6 — "Resolver + TomTicket" com resumo da IA (01/10/2026)

Botão **"Resolver + TomTicket"** no cabeçalho do atendimento, ao lado do
Resolver. Só aparece quando o atendimento tem chamado aberto. O fluxo:

1. Pergunta "Adicionar Resumo do Ticket? [Sim] [Não]".
2. Pede o resumo ao plugin de IA configurado na aba **IA**
   (`POST /p/{hash}/{id}/acoes/resumir`, com a sessão de quem clicou). Pede
   **sempre**, mesmo com "Não", porque é do resumo que sai o "Assunto principal".
3. Finaliza o chamado (`POST /chamado/finalizar` → `/ticket/finish`), em nome
   de quem resolveu. O texto começa com "Assunto principal: …" (se o resumo
   tiver essa linha) e, com "Sim", traz o resumo inteiro.
4. Só então resolve o atendimento, **sem** despedida (`PUT /tickets/:id`, igual
   ao "Resolver SEM mensagem"). Se o passo 3 falhar, o atendimento fica aberto.

Por que botão e não uma 3ª opção no diálogo "Resolver":
- os botões do diálogo são fixos no core;
- o "Resolver" do cabeçalho chama a API direto, sem passar pelo interceptador
  `resolve-ticket` (só o resolver da lista passa).

**O chamado não é renomeado:** a API do TomTicket não tem edição de chamado.
Isso foi verificado: nada na documentação, 22 rotas testadas (todas 404),
PUT/PATCH bloqueados e `subject` ignorado na transferência. Por isso o assunto
vai no texto da finalização.

Depois de finalizado, o vínculo fica marcado: o que chega com o ticket ainda
fechado (despedida, avaliação) é ignorado, para não reabrir o chamado. Se o
cliente escrever com o ticket reaberto, abre um chamado novo.

O assunto é lido do texto livre do resumo (`src/fluxo/finalizacao.ts`). Aceita
"**Assunto principal:** X", "- Assunto principal: X", "1. Assunto principal: X"
ou o rótulo numa linha e o assunto na seguinte. Sem o rótulo, nada é inventado.

## 0.1.5 — de-para por nome, assunto fixo, texto sem corte (01/10/2026)

**Atendentes e Filas escolhidos por nome**, dos dois lados. O id do TomTicket
fica só no valor gravado. Saíram o campo de texto para colar o id e o bloco de
referência da 0.1.3.

A causa real do seletor vazio da 0.1.3 era outra: dentro de um item de `list`,
o host monta os campos SEM `routePath` (`ListFieldRenderer` em
`PluginSettingsForm/index.js`), e o `select` com `endpoint` nem tenta buscar.
Não tinha a ver com o momento em que o token foi salvo. As duas abas agora são
desenhadas pelo plugin (`src/ui/telaDeDePara.ts`). As listas do Markedesk vêm
por rotas do plugin (`/opcoes/usuarios-markedesk`, `/opcoes/filas-markedesk`),
que usam `listUsers`/`listQueues` do SDK, porque a tela JSX só alcança o
plugin. O atendente Bot é escolhido na mesma aba. O formato salvo não mudou.

**Assunto fixo:** todo chamado abre como "Chamado Recebido (Origem: Markedesk)".

**Texto sem corte:** a API aceitou 20.000 caracteres inteiros, apesar dos 512 da
documentação. Acima disso, a mensagem vai em partes numeradas. Só o resumo
enviado ao webhook do n8n continua em 512.

**PDF recebido sem arquivo não é do TomTicket.** O plugin do canal HardAPI
entrega o documento ao Markedesk sem conteúdo quando o download no WhatsApp
falha. Caso visto: `url` vencida, de um PDF reaproveitado, enquanto o
`directPath` estava válido. O Markedesk grava a mensagem com `mediaUrl` vazio,
e não há arquivo para anexar.

## 0.1.4 — autor certo nas mensagens automáticas + mídia no chamado (01/10/2026)

**Mensagens automáticas apareciam como do cliente.** Menu de filas, saudação,
"a equipe X irá te atender", posição na fila: tudo entrava no chamado como
resposta do CLIENTE. Duas causas, ambas confirmadas ao vivo:

1. `/ticket/reply/operator` em chamado **sem atendente vinculado** é gravado
   como do cliente (`sender_type: "C"`), sem erro. As mensagens do bot saem
   justamente antes de alguém aceitar, quando o chamado ainda não tem atendente.
2. O autor era decidido só pelo nome do evento. Dependendo da versão do
   backend, o que o bot manda pelos canais de plugin (whatsapp_hardapi) chega
   como `ticket:messageReceived`.

Agora o autor sai da própria mensagem (`src/fluxo/mensagem.ts`):

| Mensagem | Autor no chamado |
|---|---|
| `fromMe: false` | cliente |
| começa com U+200E (a marca que o Markedesk põe em toda mensagem automática) | Bot |
| `source` = bot, system, flow, campaign, schedule, plugin ou api | Bot |
| `source` = agent | atendente |
| outras do nosso lado, com o ticket sem atendente ou fora de "open" | Bot |
| outras do nosso lado, com o ticket aceito | atendente |

**O Bot precisa ser um ATENDENTE no TomTicket**, informado na aba Atendentes
("ID do atendente Bot no TomTicket"). O cadastro `bot@markesistemas.com.br`
existente é de **cliente**, e não serve: a API não deixa escolher o autor de
uma resposta. A de cliente sai sempre em nome do dono do chamado, e a de
atendente sai em nome de quem está vinculado. Por isso o plugin vincula o
atendente Bot antes de cada mensagem automática e devolve o chamado à pessoa
antes de cada mensagem dela. Sem o Bot configurado, a mensagem automática entra
como **comentário interno**, nunca como cliente.

Com o Bot configurado, o chamado já nasce com ele vinculado. Isso também
destrava a transferência de setor, que a API recusa em chamado sem atendente
(o `departamentoPendente` quase não é mais usado).

A saudação de aceite ("meu nome é *Fulano* e darei continuidade") é enviada
pelo frontend como mensagem comum do atendente, sem marca nenhuma, e por isso
entra em nome da pessoa que aceitou.

**Mídia entra como anexo.** Imagem, áudio, vídeo, figurinha e documento são
baixados de `media.url` (a pasta `/public` do backend, aberta) e enviados como
`attachment[0]`. O texto da resposta leva o tipo ("[Imagem]", "[Áudio]"...) e a
legenda, se houver. Arquivo acima de 24 MB, ou que não pôde ser baixado, vai sem
anexo, com aviso no texto.

**Eventos de um ticket rodam em fila.** A mensagem do cliente e a resposta do
bot chegam quase juntas. Rodando em paralelo, as duas viam "sem chamado" e
cada uma abria o seu, e as respostas podiam entrar fora de ordem.

Atualizado também o caminho do SDK: `C:/markedesk-ng-main` foi movido para
`C:/REPOSITORIO MARKEDESK/markedesk-ng-main`, e o SDK lá precisou de
`npm install && npm run build` (não tinha `dist`).

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
