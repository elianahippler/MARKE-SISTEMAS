import type { PluginServer } from "@markedesk/plugin-sdk";
import { LOG } from "@/identidade";
import type { Banco } from "@/db/banco";
import { RepositorioVinculos } from "@/db/vinculos";
import { RepositorioEventos, type Evento } from "@/db/eventos";

/**
 * A mudança do PluginStorage para o SQLite, uma vez só.
 *
 * ## Por que isto não é opcional
 *
 * A versão 0.1.11 está em produção com atendimentos EM CURSO, e o vínculo
 * ticket↔chamado deles vive no PluginStorage. Subir uma versão que lê só do
 * SQLite, sem trazer o que já existe, deixaria todo chamado aberto órfão: a
 * próxima mensagem de cada atendimento não acharia vínculo, abriria um chamado
 * NOVO no TomTicket, e o cliente passaria a ter dois protocolos para o mesmo
 * assunto. O erro não apareceria no deploy — apareceria no atendimento, horas
 * depois, como chamado duplicado.
 *
 * ## O que ela NÃO faz
 *
 * Não apaga nada do PluginStorage. As chaves `ticket:*` e `diagnostico` ficam
 * onde estão, intocadas: se for preciso voltar para a 0.1.11, o estado dela
 * continua lá. O custo é algumas chaves órfãs no backend; o benefício é que o
 * rollback não perde dado.
 *
 * ## Quando ela desiste
 *
 * Se o backend não responder, a importação falha e o marco NÃO é gravado — ela
 * tenta de novo no próximo boot. Deixar o plugin subir sem o marco é melhor
 * que travar o boot: sem marco a importação se repete (e é idempotente, por
 * `ON CONFLICT`); com o boot travado, o plugin inteiro fica fora do ar por
 * causa de uma indisponibilidade passageira do storage.
 */

/** Nome do marco na tabela `marcos`. */
const MARCO = "importacao-pluginstorage";

/** Prefixo das chaves de vínculo no PluginStorage. */
const PREFIXO_VINCULO = "ticket:";

/** Chave do diagnóstico no PluginStorage. */
const CHAVE_DIAGNOSTICO = "diagnostico";

/** O vínculo como a 0.1.11 o gravava — com `transcritos` ainda como array. */
interface VinculoAntigo {
  chamadoId?: string;
  protocolo?: string;
  departamentoId?: string;
  departamentoPendente?: string;
  operadorAtual?: string;
  clienteEmail?: string;
  filaId?: string;
  finalizado?: boolean;
  finalizadoPor?: string;
  transcritos?: string[];
}

export function jaImportado(banco: Banco): boolean {
  return !!banco.prepare("SELECT 1 AS existe FROM marcos WHERE nome = ?").get(MARCO);
}

function marcarImportado(banco: Banco): void {
  banco
    .prepare("INSERT OR REPLACE INTO marcos (nome, quando) VALUES (?, ?)")
    .run(MARCO, new Date().toISOString());
}

export interface ResultadoDaImportacao {
  /** `true` quando já havia sido feita antes — nada foi tocado. */
  pulada: boolean;
  vinculos: number;
  transcricoes: number;
  eventos: number;
}

/**
 * Traz vínculos e diagnóstico do PluginStorage para o SQLite.
 *
 * Idempotente de duas formas, e as duas importam: o marco evita a releitura em
 * todo boot, e o `ON CONFLICT` dos repositórios garante que, se o marco se
 * perder, reimportar não duplica nada.
 */
export async function importarDoStorage(
  server: PluginServer,
  banco: Banco
): Promise<ResultadoDaImportacao> {
  if (jaImportado(banco)) {
    return { pulada: true, vinculos: 0, transcricoes: 0, eventos: 0 };
  }

  if (!server.client) {
    // Sem client não há storage para ler — é o caso do plugin rodando solto em
    // desenvolvimento, nunca provisionado. Marca como feita: não existe nada
    // para trazer, e sem o marco a tentativa se repetiria em todo boot.
    marcarImportado(banco);
    return { pulada: false, vinculos: 0, transcricoes: 0, eventos: 0 };
  }

  const vinculos = new RepositorioVinculos(banco);
  const eventos = new RepositorioEventos(banco);

  let totalVinculos = 0;
  let totalTranscricoes = 0;
  let totalEventos = 0;

  const chaves = await server.client.storage.list(PREFIXO_VINCULO);

  for (const item of chaves || []) {
    // `storage.list` devolve a chave inteira (`ticket:123`); o id é o resto.
    const ticketId = String(item.key || "").slice(PREFIXO_VINCULO.length);
    const antigo = item.value as VinculoAntigo | null;

    // Vínculo sem chamado não é vínculo — é lixo de uma gravação parcial, e
    // importá-lo criaria uma linha que o fluxo trataria como chamado existente.
    if (!ticketId || !antigo?.chamadoId) continue;

    vinculos.gravar(ticketId, {
      chamadoId: antigo.chamadoId,
      protocolo: antigo.protocolo,
      departamentoId: antigo.departamentoId,
      departamentoPendente: antigo.departamentoPendente,
      operadorAtual: antigo.operadorAtual,
      clienteEmail: antigo.clienteEmail || "",
      filaId: antigo.filaId,
      finalizado: antigo.finalizado,
      finalizadoPor: antigo.finalizadoPor as any
    });
    totalVinculos++;

    for (const wid of antigo.transcritos || []) {
      if (!wid) continue;
      vinculos.marcarTranscrito(ticketId, String(wid));
      totalTranscricoes++;
    }
  }

  // O diagnóstico é auxiliar: se só ele falhar, não vale perder a importação
  // dos vínculos, que é a parte que o atendimento precisa.
  try {
    const gravados = await server.client.storage.get<Evento[]>(CHAVE_DIAGNOSTICO);
    const lista = (gravados || []).filter(e => e?.quando && e?.nivel && e?.texto);
    eventos.registrarVarios(lista);
    totalEventos = lista.length;
  } catch (err: any) {
    console.warn(`${LOG} diagnóstico antigo não foi importado: ${err?.message || err}`);
  }

  marcarImportado(banco);

  console.log(
    `${LOG} importação do PluginStorage concluída: ${totalVinculos} vínculo(s), ` +
      `${totalTranscricoes} transcrição(ões), ${totalEventos} evento(s) de diagnóstico`
  );

  return {
    pulada: false,
    vinculos: totalVinculos,
    transcricoes: totalTranscricoes,
    eventos: totalEventos
  };
}
