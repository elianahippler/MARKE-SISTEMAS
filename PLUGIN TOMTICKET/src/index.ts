/**
 * Plugin TomTicket — integração com o help desk TomTicket.
 *
 * Modo standalone: um container por empresa.
 */
import { PLUGIN_NOME } from "@/identidade";
import { createTomTicketInstance } from "@/tomticketInstance";

const { server } = createTomTicketInstance();

server.start();
console.log(`${PLUGIN_NOME} no ar`);
