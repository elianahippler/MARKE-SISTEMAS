/**
 * O que a aba "Diagnóstico" mostra: os últimos erros, avisos e chamados.
 *
 * Antes, a única forma de saber por que um atendimento não virou chamado era
 * abrir os logs do container no Portainer. Aqui o plugin guarda as linhas de
 * log DELE (as que começam com o prefixo `[TomTicket]`) e a configuração as
 * mostra.
 *
 * Captura no `console`, e não com chamada explícita em cada ponto: são ~30
 * pontos de log, e qualquer um novo entraria no diagnóstico sem ninguém
 * lembrar de registrar. O console original continua sendo chamado — os logs
 * do container não mudam.
 *
 * Persistido no PluginStorage (com espera, para não gravar a cada linha)
 * porque o container reinicia a cada atualização: sem isso o diagnóstico
 * sumiria justamente depois de publicar uma versão nova.
 */
import type { PluginServer } from "@markedesk/plugin-sdk";
import { LOG } from "@/identidade";

export type Nivel = "erro" | "aviso" | "info";

export interface Evento {
  quando: string;
  nivel: Nivel;
  texto: string;
}

/** Quantos eventos guardar. O bastante para um dia normal, sem pesar no storage. */
const MAXIMO = 200;
const CHAVE = "diagnostico";
/** Espera antes de gravar: uma rajada de logs vira uma gravação só. */
const ESPERA_GRAVACAO_MS = 5_000;

let eventos: Evento[] = [];
let carregado = false;
let agendado: ReturnType<typeof setTimeout> | null = null;
let servidor: PluginServer | null = null;
let capturando = false;
const desde = new Date().toISOString();

function textoDe(args: unknown[]): string {
  return args
    .map(a => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(" ")
    .replace(LOG, "")
    .trim();
}

function registrar(nivel: Nivel, args: unknown[]): void {
  eventos.push({ quando: new Date().toISOString(), nivel, texto: textoDe(args) });
  if (eventos.length > MAXIMO) eventos = eventos.slice(-MAXIMO);
  agendarGravacao();
}

function agendarGravacao(): void {
  if (agendado || !servidor?.client) return;
  agendado = setTimeout(async () => {
    agendado = null;
    try {
      await carregar();
      await servidor?.client?.storage.set(CHAVE, eventos);
    } catch {
      // Diagnóstico é auxiliar: falhar ao gravar não pode virar um log de
      // erro — que dispararia outra gravação.
    }
  }, ESPERA_GRAVACAO_MS);
}

/** Junta o que estava gravado (antes do restart) com o que chegou desde então. */
async function carregar(): Promise<void> {
  if (carregado || !servidor?.client) return;
  carregado = true;
  try {
    const gravados = (await servidor.client.storage.get<Evento[]>(CHAVE)) || [];
    eventos = [...gravados, ...eventos].slice(-MAXIMO);
  } catch {
    carregado = false;
  }
}

/**
 * Passa a registrar as linhas de log do plugin. Chamar uma vez, ao criar a
 * instância.
 */
export function capturarLogs(server: PluginServer): void {
  servidor = server;
  // Embrulhar duas vezes registraria cada linha em dobro.
  if (capturando) return;
  capturando = true;
  const original = { log: console.log, warn: console.warn, error: console.error };
  const niveis: Array<[keyof typeof original, Nivel]> = [["log", "info"], ["warn", "aviso"], ["error", "erro"]];

  for (const [metodo, nivel] of niveis) {
    console[metodo] = (...args: unknown[]) => {
      original[metodo](...args);
      if (typeof args[0] === "string" && args[0].startsWith(LOG)) {
        try {
          registrar(nivel, args);
        } catch {
          /* nunca derrubar quem só queria escrever um log */
        }
      }
    };
  }
}

/** O que a aba mostra: eventos mais recentes primeiro. */
export async function lerDiagnostico(): Promise<{ desde: string; eventos: Evento[] }> {
  await carregar();
  return { desde, eventos: [...eventos].reverse() };
}
