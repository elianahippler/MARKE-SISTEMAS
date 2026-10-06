# Publicar o plugin TomTicket no Portainer de homologação

Para colocar o plugin no ar e instalá-lo numa empresa de testes do Markedesk:

São quatro etapas. A primeira gera a imagem dentro do servidor, a segunda sobe o
container, a terceira registra o plugin no Markedesk e a quarta configura.

**Observação:** o build acontece **no servidor**, não na sua máquina — não há
Docker instalado nela. Também não é preciso Docker Hub: a imagem fica guardada
no próprio servidor de homologação.

Dados usados neste manual:

| Item | Valor |
|---|---|
| Portainer | http://45.140.192.86:9000 |
| Ambiente | **local** |
| Nome da imagem | `marke-plugin-tomticket:0.1.0` |
| Porta no servidor | **32900** |
| Arquivo a enviar | `build-context.tar.gz` (na pasta do plugin) |

**Atenção:** a porta 32900 foi escolhida por estar livre hoje. Se o Portainer
acusar que ela já está em uso, trocar por outra acima de 32000 e ajustar também
o `PUBLIC_URL` na etapa 2.

---

## Etapa 1 — Gerar a imagem no servidor

**1°** Abrir o navegador em **http://45.140.192.86:9000** e entrar com o seu
usuário.

**2°** No menu do lado esquerdo, clicar em **local** (o ambiente).

**3°** No menu do lado esquerdo, clicar em **Images**.

**4°** Clicar em **Build a new image** (botão no topo da lista).

**5°** No campo **Naming**, em **Image name**, digitar:

```
marke-plugin-tomticket:0.1.0
```

**6°** Em **Build method**, escolher a opção **Upload**.

**7°** Clicar em **Select file** e escolher o arquivo:

```
D:\PROGRAMAS DESENVOLVIDOS\PLUGIN TOMTICKET\build-context.tar.gz
```

**8°** No campo **Dockerfile path** (fica logo acima ou abaixo do upload,
conforme a tela), apagar o que estiver escrito e digitar:

```
plugins/plugin-tomticket/Dockerfile
```

**Observação:** esse caminho é dentro do arquivo enviado, não do seu computador.
O arquivo já vem com as pastas `packages/` e `plugins/` na posição certa.

**9°** Clicar em **Build the image** e aguardar. A tela mostra o andamento linha
a linha. Leva alguns minutos na primeira vez.

**10°** Ao terminar, conferir que a última linha traz **Successfully tagged
marke-plugin-tomticket:0.1.0**.

**Atenção:** se aparecer erro em vermelho, copiar as últimas 15 linhas e enviar
para análise antes de seguir. Não adianta continuar sem a imagem.

---

## Etapa 2 — Subir o container

**1°** No menu do lado esquerdo, clicar em **Stacks**.

**2°** Clicar em **Add stack** (botão no topo da lista).

**3°** No campo **Name**, digitar:

```
markedesk-tomticket-teste
```

**4°** Em **Build method**, deixar marcado **Web editor**.

**5°** Colar no editor exatamente o conteúdo abaixo:

```yaml
version: "3.8"

services:
  plugin:
    image: marke-plugin-tomticket:0.1.0
    container_name: markedesk-tomticket-teste
    restart: unless-stopped
    mem_limit: 512m
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    ports:
      - "32900:3033"
    environment:
      PORT: "3033"
      PUBLIC_URL: "http://45.140.192.86:32900"
      PLUGIN_WORKSPACE: "/app/data"
    volumes:
      - markedesk-tomticket-teste-data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "1"

volumes:
  markedesk-tomticket-teste-data:
```

**Atenção:** não ligar a opção de puxar a imagem (**Re-pull image** ou **Pull
latest image**). A imagem foi criada no próprio servidor e não existe no Docker
Hub — ligando essa opção o Portainer tenta baixar e falha.

**6°** Clicar em **Deploy the stack**, no fim da página, e aguardar.

**7°** Conferir que o container subiu: no menu do lado esquerdo, clicar em
**Containers** e localizar **markedesk-tomticket-teste** com a situação
**running**.

**Observação:** o `PLUGIN_WORKSPACE` e o volume são o que preserva a
configuração do plugin quando o container é recriado. Sem eles, o token e os
mapeamentos se perdem a cada atualização.

**A partir da 0.2.0 isso vale para mais coisa.** O banco do plugin
(`tomticket.db`, SQLite) fica nessa mesma pasta, e é nele que vivem os
vínculos ticket↔chamado. Sem o volume, cada atualização do container perde os
vínculos dos atendimentos EM CURSO — e a próxima mensagem de cada um abre um
**segundo** chamado no TomTicket, deixando o cliente com dois protocolos para o
mesmo assunto.

Para conferir depois do deploy: Plugins → TomTicket → Configurar → aba
**Diagnóstico**. O rodapé mostra quantos vínculos o banco tem. Se estiver em
zero logo depois de atualizar uma instalação que já atendia, o volume não subiu
montado.

---

## Etapa 3 — Registrar o plugin no Markedesk

**1°** Entrar no Markedesk com o usuário da **empresa de testes**.

**2°** No menu do lado esquerdo, clicar em **Plugins**.

**3°** Clicar em **Adicionar Plugin Remoto** (botão no topo da tela).

**4°** No campo da URL do servidor, digitar:

```
http://45.140.192.86:32900
```

**5°** Aguardar alguns segundos sem clicar em nada. A tela busca sozinha as
informações do plugin e mostra o nome **TomTicket** com a versão **0.1.0**.

**Observação:** se ficar carregando ou mostrar erro, o container não está
acessível. Voltar à Etapa 2 e conferir se ele está **running**.

**6°** Clicar no botão de confirmar o cadastro. Aparece a mensagem **Plugin
"TomTicket" registrado!**.

---

## Etapa 4 — Configurar o plugin

**1°** Ainda em **Plugins**, localizar o cartão do **TomTicket** e abrir
**Configurar**.

**2°** Na aba **Conexão**, colar o **Token da API** do TomTicket e clicar em
**Testar conexão**. A mensagem deve dizer **Conexão OK** com a quantidade de
atendentes encontrados.

Salvar.

**Mudou na 0.3.0:** o campo **Webhook do n8n** não existe mais. O plugin guarda
o vínculo ticket↔chamado no banco próprio, e quem precisa dele de fora consulta
`GET /vinculos` em vez da tabela `comunica`. Quem está atualizando de uma versão
anterior não precisa fazer nada: o valor antigo fica salvo e é ignorado.

**Atenção:** salvar antes de ir para as outras abas. As listas de atendentes,
setores e categorias são buscadas com o token — sem ele salvo, os campos das
outras abas aparecem vazios.

**4°** Na aba **Categorias**, preencher:

- **Setor inicial** e **Categoria inicial**: onde o chamado nasce quando o
  atendimento começa, antes de entrar numa fila.
- Abaixo, a categoria de cada setor.

**5°** Na aba **Atendentes**, clicar em **Adicionar atendente** e ligar cada
atendente do Markedesk ao correspondente no TomTicket.

**6°** Na aba **Filas**, clicar em **Adicionar fila** e ligar cada fila do
Markedesk ao setor correspondente no TomTicket.

**7°** Salvar.

---

## Conferir se está funcionando

**1°** Enviar uma mensagem de teste para a empresa de testes, a partir de um
contato que tenha **email preenchido no cadastro** e que exista como cliente no
TomTicket **com o mesmo email**.

**Atenção:** o cliente é identificado pelo email. Contato sem email, ou com
email que não existe no TomTicket, não gera chamado.

**2°** Abrir o TomTicket e conferir que apareceu um chamado novo no setor
inicial configurado, sem atendente.

**3°** No Markedesk, aceitar o atendimento e responder. Conferir no chamado que
o atendente foi vinculado e que as mensagens dos dois lados aparecem.

**Caso o chamado não apareça:** ver o log do container. No Portainer, em
**Containers**, clicar em **markedesk-tomticket-teste** e depois em **Logs**. As
linhas começam com `[TomTicket]` e dizem o motivo — por exemplo "sem email no
contato", "setor inicial não configurado" ou "fila não mapeada".

---

## Atualizar o plugin depois de mudanças no código

**1°** Gerar o pacote novo. Na pasta do plugin, no terminal:

```
npm run empacotar
```

O arquivo `build-context.tar.gz` é regravado com o código atual.

**2°** Repetir a **Etapa 1**, trocando o número da versão no nome da imagem (por
exemplo `marke-plugin-tomticket:0.1.1`).

**3°** Em **Stacks**, abrir **markedesk-tomticket-teste**, clicar em **Editor**,
trocar a versão na linha `image:` e clicar em **Update the stack**.

**Observação:** trocar o número da versão a cada build evita o caso em que o
Docker reaproveita a imagem antiga por ter o mesmo nome, e a correção não sobe.
