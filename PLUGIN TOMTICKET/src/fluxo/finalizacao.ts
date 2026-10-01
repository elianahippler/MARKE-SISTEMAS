/**
 * Os textos que o plugin escreve no chamado por conta própria: o assunto, a
 * finalização (pelo botão "Finalizar Chamado" ou pela transferência) e a
 * transcrição de áudio.
 *
 * O ideal seria renomear o chamado para o assunto principal, mas a API do
 * TomTicket não tem como editar um chamado — confirmado em 01/10/2026: nada na
 * documentação, 22 rotas candidatas respondendo 404, PUT/PATCH bloqueados no
 * servidor e `subject` ignorado na transferência. O assunto vai então no começo
 * do texto da finalização.
 */

/** Tira a marcação que o modelo costuma usar em volta do texto ("**", "#", "- ", "1."). */
function semMarcacao(texto: string): string {
  return texto
    .replace(/^[\s>#*•\-–—]+/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/[*_`]+/g, "")
    .trim();
}

/**
 * O assunto principal escrito no resumo da IA, ou `undefined`.
 *
 * O resumo é texto livre (o AI-Tools pede "assunto principal" como um dos
 * tópicos), então o formato varia: "**Assunto principal:** X", "- Assunto
 * principal: X", ou o rótulo numa linha e o assunto na seguinte. Sem o rótulo,
 * nada é inventado — o chamado fica como está.
 */
export function extrairAssunto(resumo?: string | null): string | undefined {
  const linhas = String(resumo || "").split(/\r?\n/);

  for (let i = 0; i < linhas.length; i++) {
    const limpa = semMarcacao(linhas[i]);
    const casou = /^assunto\s+principal\s*[:\-–—]?\s*(.*)$/i.exec(limpa);
    if (!casou) continue;

    const naMesmaLinha = semMarcacao(casou[1]);
    if (naMesmaLinha) return naMesmaLinha;

    // Rótulo sozinho: o assunto é a próxima linha com conteúdo.
    for (let j = i + 1; j < linhas.length; j++) {
      const seguinte = semMarcacao(linhas[j]);
      if (seguinte) return seguinte;
    }
    return undefined;
  }

  return undefined;
}

/**
 * Por que o chamado foi finalizado: o atendimento acabou ("Finalizar
 * Chamado" + Resolver) ou mudou de mãos (transferência no Markedesk).
 */
export type MotivoDaFinalizacao = "resolvido" | "transferencia";

/** Texto que finaliza o chamado. */
export function textoDeFinalizacao(opcoes: {
  assunto?: string;
  resumo?: string | null;
  comResumo: boolean;
  motivo?: MotivoDaFinalizacao;
}): string {
  const partes: string[] = [];
  // Na transferência o aviso vem primeiro: é o que explica, a quem abrir o
  // chamado depois, por que ele terminou sem o atendimento ter acabado.
  if (opcoes.motivo === "transferencia") {
    partes.push("Atendimento transferido no Markedesk — a continuação fica em um novo chamado.");
  }
  if (opcoes.assunto) partes.push(`Assunto principal: ${opcoes.assunto}`);
  if (opcoes.comResumo && opcoes.resumo) partes.push(`Resumo do atendimento (gerado por IA):\n${opcoes.resumo.trim()}`);
  return partes.length ? partes.join("\n\n") : "Atendimento finalizado no Markedesk.";
}

/** Assunto de todo chamado aberto pelo plugin, com o ticket que o originou. */
export function assuntoDoChamado(ticketId: number | string): string {
  return `Chamado Recebido | Origem: Markedesk | Ticket #${ticketId}`;
}

/**
 * Respostas do "Transcrever" do Markedesk que NÃO são transcrição.
 *
 * O backend devolve 200 com o aviso no corpo, no lugar do texto (ver
 * TranscribeAudioMessageService) — sem este filtro, "Conversão pra texto
 * falhou" entraria no chamado como se fosse o que o cliente falou.
 */
const FALHAS_DA_TRANSCRICAO = [
  /^serviço de transcrição ocupado/i,
  /^transcrição não habilitada/i,
  /^conversão pra texto falhou/i,
  /^não foi possível reconhecer o áudio/i,
  /^erro ao transcrever/i,
  /^transcrição demorou demais/i
];

/** O texto da transcrição, limpo — ou `undefined` quando é aviso de falha. */
export function transcricaoValida(texto?: unknown): string | undefined {
  if (typeof texto !== "string") return undefined;
  const limpo = texto.trim();
  if (!limpo || FALHAS_DA_TRANSCRICAO.some(re => re.test(limpo))) return undefined;
  return limpo;
}

/** Como a transcrição entra no chamado. */
export function textoDaTranscricao(texto: string): string {
  return `🎙️ Áudio transcrito por inteligência artificial:\n${texto}`;
}

/**
 * Minutos entre uma data do TomTicket e agora (mínimo 1), ou `undefined`.
 *
 * O TomTicket escreve as datas como "2026-09-30 16:46:10-03" (o detalhe) ou
 * "...-03:00" (a lista) — nenhuma das duas é ISO que o `Date` aceite em todo
 * lugar: falta o "T" e, na primeira, os minutos do fuso.
 */
export function minutosDesde(data?: string | null, agora = Date.now()): number | undefined {
  if (!data) return undefined;
  const iso = String(data).trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const inicio = Date.parse(iso);
  if (Number.isNaN(inicio) || inicio > agora) return undefined;
  return Math.max(1, Math.round((agora - inicio) / 60_000));
}
