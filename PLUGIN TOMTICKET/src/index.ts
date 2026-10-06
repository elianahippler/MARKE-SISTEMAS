/**
 * Plugin TomTicket — integração com o help desk TomTicket.
 *
 * Modo standalone: um container por empresa.
 */
import { PLUGIN_NOME } from "@/identidade";
import { createTomTicketInstance } from "@/tomticketInstance";

const { server, iniciar } = createTomTicketInstance();

/**
 * O banco abre ANTES de o servidor aceitar requisição.
 *
 * Não é preferência de ordem — é correção: o `start()` passa a receber hooks
 * de atendimento, e um hook atendido antes de a importação do PluginStorage
 * terminar leria "sem vínculo" num ticket que já tem chamado aberto, abrindo
 * um segundo chamado no TomTicket para o mesmo assunto.
 *
 * Se o banco não abrir, o processo SAI com código 1 em vez de subir sem ele.
 * Um plugin no ar sem banco espelharia os atendimentos no TomTicket sem
 * guardar vínculo nenhum: cada mensagem abriria um chamado novo. Morrer alto
 * é melhor — o container reinicia e o erro aparece no log, em vez de o estrago
 * aparecer nos chamados do cliente.
 */
iniciar()
  .then(() => {
    server.start();
    console.log(`${PLUGIN_NOME} no ar`);
  })
  .catch(err => {
    console.error(`${PLUGIN_NOME} não subiu: ${err?.message || err}`);
    process.exit(1);
  });
