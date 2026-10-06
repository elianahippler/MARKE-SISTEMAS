# Changelog — Plugin TomTicket

Histórico de versões do plugin, da mais recente para a mais antiga.

Cada entrada diz **o que mudou e por quê** — a decisão, não só o arquivo
tocado. O que é documentação permanente (como o fluxo funciona, o que a API do
TomTicket faz de estranho) fica no [README](README.md), não aqui.

As versões publicadas estão em
[hub.docker.com/r/elianahippler/marke-plugin-tomticket](https://hub.docker.com/r/elianahippler/marke-plugin-tomticket/tags).

---

## 0.3.1 — desempenho do banco (06/10/2026)

Nenhuma mudança de comportamento: as mesmas respostas, mais rápido. Medido com
5.000 vínculos e 5.000 eventos, antes e depois.

| Operação | Antes | Depois | |
|---|---:|---:|---|
| Ler o vínculo do ticket (toda mensagem) | 36,2 µs | 6,2 µs | 5,8× |
| Gravar o vínculo (toda mensagem) | 47,1 µs | 10,0 µs | 4,7× |
| `jaTranscrito` (todo áudio) | 6,8 µs | 0,6 µs | 11× |
| Buscar por protocolo ou hash | 834 µs | 38,6 µs | **21,6×** |
| Registrar linha de log | 24,3 µs | 11,7 µs | 2,1× |
| Contagens da aba Diagnóstico | 331 µs | 162 µs | 2,0× |

Duas causas, as duas confirmadas por medição e não por suposição:

**1. `prepare()` recompilava o mesmo SQL a cada chamada.** Compilar
`SELECT * FROM vinculos WHERE ticket_id = ?` custa 17,7 µs contra 10,2 µs do
`get()` — 61% do tempo da leitura era recompilação. Agora os statements ficam
em cache por banco (`preparado`, em `src/db/banco.ts`).

**2. A busca da tela varria a tabela inteira.** `protocolo = ? OR chamado_id = ?`
tinha índice só no primeiro lado, e um OR com um lado não indexado impede a
união de índices — o SQLite desistia dos dois e fazia `SCAN vinculos`. A
migração 3 indexa `chamado_id`, e o plano virou `MULTI-INDEX OR` com duas
buscas. Ela também adiciona dois índices parciais: os vínculos abertos na ordem
da listagem, e as linhas "de chamado" da aba Diagnóstico.

Os planos de consulta viraram teste (`banco.test.ts`): derrubar qualquer um
desses índices quebra a suíte, em vez de só deixar a tela lenta.

## 0.3.0 — fim do webhook do n8n (06/10/2026)

O vínculo ticket↔chamado passou a viver **só** no SQLite. O `webhookVinculo`
saiu do código e da aba Conexão, e a tabela `comunica` (Postgres, via n8n)
para de receber linhas novas.

Os três campos que só existiam naquele POST viraram colunas do vínculo, pela
migração 2: `categoria_id`, `mensagem` e `canal`. Sem isso, apagar o webhook
perderia o dado calado.

Quem lia a tabela `comunica` precisa passar a ler `GET /vinculos`. Ver
[O vínculo no banco](README.md#o-vínculo-no-banco), no README.

## 0.2.0 — banco próprio (SQLite) (06/10/2026)

O plugin passou a guardar o estado dele num **SQLite próprio**, em
`/app/data/tomticket.db` — o mesmo volume onde já vive o `plugin-config.json`.
Antes tudo ficava no `PluginStorage`, que é uma tabela chave-valor **dentro do
backend do Markedesk**, alcançada por HTTP.

O que isso resolve:

| Antes (PluginStorage) | Agora (SQLite) |
|---|---|
| O vínculo ticket↔chamado dependia do backend estar no ar; o próprio código avisava que "o que se perde é o vínculo depois de um restart" | Arquivo local, no volume. Vínculo perdido só se o volume se perder — o mesmo risco que já vale para o token |
| Não havia como consultar: chave-valor por `ticket:{id}` só responde o caminho de ida | `GET /vinculos` lista, filtra por protocolo e por abertos — era isso que o webhook do n8n ia buscar fora, e que na 0.3.0 deixou de existir |
| Diagnóstico: array de 200 eventos reescrito INTEIRO a cada rajada de log, com espera de 5 s para agrupar gravações | Append-only, teto de 5.000, poda por idade e quantidade, filtro e contagem no servidor |
| A aba contava "Erros e avisos (3)" entre os 200 baixados — não entre os que existem | A contagem vem de `COUNT(*)` |
| Transcrições de áudio: array no vínculo com teto de 50 | Tabela própria, sem teto |

**Migração automática.** No primeiro boot o plugin importa os vínculos e o
diagnóstico que estavam no PluginStorage, e grava uma marca para não repetir.
Isso não é conforto: sem a importação, todo atendimento em curso ficaria órfão e
abriria um **segundo** chamado no TomTicket na próxima mensagem — o cliente com
dois protocolos para o mesmo assunto, e o estrago aparecendo horas depois.
Nada é apagado do PluginStorage: voltar para a 0.1.11 continua possível.

**O webhook do n8n saiu (0.3.0).** O plugin não posta mais em
`comunica/grava`, e o campo "Webhook do n8n" sumiu da aba Conexão. Os três
campos que só existiam naquele POST — categoria, mensagem e canal — viraram
colunas do vínculo, e `GET /vinculos` é agora o único caminho para quem
consome de fora.

> **Atenção, quem lê a tabela `comunica`:** ela para de receber linhas novas a
> partir desta versão. O que já está lá continua lá (nada foi apagado), mas
> relatórios e fluxos que dependem dela precisam passar a ler `GET /vinculos`.
> O webhook `comunica/consulta`, do mesmo workflow, nunca foi chamado pelo
> plugin — se alguém o usa, continua funcionando sobre os dados antigos.

**Exige Node 24.** O banco usa o módulo nativo `node:sqlite`, que só dispensa
a flag `--experimental-sqlite` a partir do 24 — a imagem subiu de
`node:20-alpine` para `node:24-alpine`. A alternativa, `better-sqlite3`,
compilaria do zero no Alpine (musl) e exigiria python3, make e g++ no build,
para um plugin que não tem uma única dependência nativa. **Zero dependências
novas.**

Novas rotas: `GET /vinculos` (lista, com `?protocolo=`, `?ticketId=`,
`?abertos=1`, `?limite=`) e `GET /banco` (estado do banco). O rodapé da aba
Diagnóstico mostra quantos vínculos existem, quantos em aberto e o tamanho do
arquivo — a primeira coisa a conferir quando "o plugin perdeu os chamados": zero
vínculos logo depois de um deploy significa volume não montado.

## 0.1.11 — botão mais alto (01/10/2026)

O botão "Finalizar Chamado" ocupa a altura da barra do cabeçalho: 36px de
altura, margem de 6px em cima e embaixo e 8px nas laterais, e logo de 20px.

## 0.1.9 — diálogo do "Finalizar Chamado" só com OK (01/10/2026)

O diálogo não pergunta mais "Adicionar Resumo do Ticket? [Sim] [Não]". Tem só
**Cancelar** e **OK**, e o resumo da IA vai sempre que houver plugin de IA
configurado.

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
gravado na coluna `mensagem` do vínculo continua em 512.

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
