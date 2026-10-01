/**
 * O texto com que o chamado é finalizado pelo botão "Resolver + TomTicket".
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

/** Texto que finaliza o chamado. */
export function textoDeFinalizacao(opcoes: {
  assunto?: string;
  resumo?: string | null;
  comResumo: boolean;
}): string {
  const partes: string[] = [];
  if (opcoes.assunto) partes.push(`Assunto principal: ${opcoes.assunto}`);
  if (opcoes.comResumo && opcoes.resumo) partes.push(`Resumo do atendimento (gerado por IA):\n${opcoes.resumo.trim()}`);
  return partes.length ? partes.join("\n\n") : "Atendimento finalizado no Markedesk.";
}
