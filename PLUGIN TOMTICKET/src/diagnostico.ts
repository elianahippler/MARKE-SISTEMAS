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
 * ## O que mudou com o banco próprio
 *
 * Era um array de 200 eventos no PluginStorage, regravado INTEIRO a cada
 * rajada de log — daí a espera de 5 s que existia só para agrupar gravações.
 * Agora cada linha é um INSERT no SQLite local: a espera saiu, o teto subiu de
 * 200 para 5.000 e a aba filtra no servidor (ver `db/eventos.ts`).
 *
 * O buffer em memória continua, mas com outro papel: ele cobre a janela entre
 * o primeiro log do processo e o banco estar aberto. Sem ele, tudo que o boot
 * registra — inclusive um erro de provisionamento, que é justamente o que
 * alguém vai procurar — se perderia.
 */
import type { PluginServer } from "@markedesk/plugin-sdk";
import { LOG } from "@/identidade";
import { RepositorioEventos, type Evento, type Filtro, type Nivel } from "@/db/eventos";
import { estatisticas, type Banco } from "@/db/banco";

export type { Evento, Nivel } from "@/db/eventos";

/**
 * Teto do buffer de boot.
 *
 * Pequeno de propósito: ele só precisa cobrir os segundos até o banco abrir.
 * Um teto grande transformaria uma falha na abertura do banco (quando o
 * buffer nunca drena) num vazamento de memória silencioso.
 */
const MAXIMO_NO_BUFFER = 500;

let repositorio: RepositorioEventos | null = null;
let banco: Banco | null = null;
/** Logs que chegaram antes do banco abrir. */
let buffer: Evento[] = [];
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
  const evento: Evento = { quando: new Date().toISOString(), nivel, texto: textoDe(args) };

  if (!repositorio) {
    buffer.push(evento);
    if (buffer.length > MAXIMO_NO_BUFFER) buffer = buffer.slice(-MAXIMO_NO_BUFFER);
    return;
  }

  try {
    repositorio.registrar(evento);
  } catch {
    // Diagnóstico é auxiliar: falhar ao gravar não pode virar um log de erro —
    // que entraria aqui de novo e viraria recursão.
  }
}

/**
 * Passa a registrar as linhas de log do plugin. Chamar uma vez, ao criar a
 * instância — ANTES de abrir o banco, para o buffer pegar os logs do boot.
 */
export function capturarLogs(_server: PluginServer): void {
  // Embrulhar duas vezes registraria cada linha em dobro.
  if (capturando) return;
  capturando = true;

  const original = { log: console.log, warn: console.warn, error: console.error };
  const niveis: Array<[keyof typeof original, Nivel]> = [
    ["log", "info"],
    ["warn", "aviso"],
    ["error", "erro"]
  ];

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

/**
 * Liga o diagnóstico ao banco e drena o que o boot acumulou.
 *
 * Separado de `capturarLogs` porque a ordem importa: a captura começa no
 * primeiro instante do processo, e o banco só existe depois de uma abertura
 * assíncrona. Juntar os dois obrigaria a escolher entre perder os logs do boot
 * ou atrasar a captura.
 */
export function usarBanco(bancoAberto: Banco): void {
  banco = bancoAberto;
  repositorio = new RepositorioEventos(bancoAberto);

  if (buffer.length) {
    const pendentes = buffer;
    buffer = [];
    try {
      repositorio.registrarVarios(pendentes);
    } catch {
      /* ver `registrar`: diagnóstico não derruba nada */
    }
  }
}

/** O que a aba mostra: a página pedida, as contagens reais e o estado do banco. */
export async function lerDiagnostico(
  filtro: Filtro = "problemas",
  limite = 300
): Promise<{
  desde: string;
  filtro: Filtro;
  eventos: Evento[];
  contagens: { problemas: number; chamados: number; tudo: number };
  banco: ReturnType<typeof estatisticas> | null;
}> {
  if (!repositorio || !banco) {
    // O banco ainda não abriu (ou falhou). Mostrar o buffer é melhor que uma
    // tela vazia: é exatamente nesse cenário que a causa está nele.
    const doBuffer = [...buffer].reverse();
    return {
      desde,
      filtro,
      eventos: doBuffer,
      contagens: {
        problemas: doBuffer.filter(e => e.nivel !== "info").length,
        chamados: 0,
        tudo: doBuffer.length
      },
      banco: null
    };
  }

  return {
    desde,
    filtro,
    eventos: repositorio.listar(filtro, limite),
    contagens: repositorio.contagens(),
    banco: estatisticas(banco)
  };
}
