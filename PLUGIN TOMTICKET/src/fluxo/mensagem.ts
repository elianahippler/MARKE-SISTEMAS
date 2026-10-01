/**
 * Como uma mensagem do Markedesk vira conteúdo no chamado: quem falou, o texto
 * e o arquivo anexado.
 */
import { LOG } from "@/identidade";
import type { Anexo } from "@/tomticket/api";

export type Autor = "cliente" | "atendente" | "bot";

/**
 * Tamanho máximo de cada envio ao chamado.
 *
 * A documentação fala em 512 caracteres, mas a API grava bem mais: 1.500, 5.000
 * e 20.000 caracteres entraram inteiros (testado ao vivo em 01/10/2026, em
 * resposta de cliente, de atendente e em comentário). 20.000 é o maior valor
 * confirmado; acima dele a mensagem vai em partes numeradas, em vez de cortada.
 */
const LIMITE_MENSAGEM = 20_000;

/** O resumo gravado no banco pelo webhook do n8n — ali o texto é só referência. */
const LIMITE_RESUMO = 512;

/**
 * Marca que o próprio Markedesk põe no início de toda mensagem automática
 * (menu de filas, saudação da fila, transferência, IA, flow) — U+200E, um
 * caractere invisível. O backend usa a mesma marca para reconhecer o que é do
 * bot no listener nativo.
 */
const MARCA_DO_BOT = "‎";

/** `source` que nunca é uma pessoa digitando (ver MessageSource no SDK). */
const ORIGENS_AUTOMATICAS = new Set(["bot", "system", "flow", "campaign", "schedule", "plugin", "api"]);

/**
 * Teto do arquivo anexado. A API aceita 25 MB pela requisição INTEIRA, então
 * sobra uma margem para o texto e o envelope do multipart.
 */
const LIMITE_ANEXO = 24 * 1024 * 1024;

/** Texto curto para o banco (tabela `comunica`), com reticência quando cortado. */
export function resumo(texto: string): string {
  if (texto.length <= LIMITE_RESUMO) return texto;
  return `${texto.slice(0, LIMITE_RESUMO - 3)}...`;
}

/**
 * O texto dividido em envios que a API aceita, cada um identificado.
 *
 * Quebra preferindo fim de linha, depois espaço — cortar no meio de uma palavra
 * atrapalha quem lê. Texto que cabe num envio volta como está, sem rótulo.
 */
export function emPartes(texto: string): string[] {
  if (texto.length <= LIMITE_MENSAGEM) return [texto];

  // Folga para o rótulo "(parte 99/99)\n".
  const tamanho = LIMITE_MENSAGEM - 20;
  const pedacos: string[] = [];
  let resto = texto;

  while (resto.length > tamanho) {
    const janela = resto.slice(0, tamanho);
    const quebra = Math.max(janela.lastIndexOf("\n"), janela.lastIndexOf(" "));
    const corte = quebra > tamanho / 2 ? quebra + 1 : tamanho;
    pedacos.push(resto.slice(0, corte));
    resto = resto.slice(corte);
  }
  if (resto) pedacos.push(resto);

  return pedacos.map((pedaco, i) => `(parte ${i + 1}/${pedacos.length})\n${pedaco}`);
}

/**
 * Quem escreveu a mensagem.
 *
 * O nome do evento não basta: dependendo da versão do backend, o que o bot
 * manda pelos canais de plugin (whatsapp_hardapi) chegava como
 * `ticket:messageReceived`. O que vale é a própria mensagem — `fromMe` separa
 * o cliente do nosso lado, e do nosso lado separa pessoa de automação.
 *
 * `source` sozinho também não basta: pelo WhatsApp quase tudo chega como
 * "unknown" (o backend não guarda quem disparou). Por isso, sem marca nem
 * origem conclusiva, decide o estado do ticket: enquanto ninguém aceitou o
 * atendimento (sem atendente ou fora de "open"), só a automação fala por nós —
 * é o caso do menu, da transferência e da posição na fila.
 */
export function autorDaMensagem(
  mensagem: any,
  ticket: any,
  doEvento: "cliente" | "atendente"
): Autor {
  // Backend antigo, sem a mensagem no payload: o evento é tudo que se tem.
  if (typeof mensagem?.fromMe !== "boolean") return doEvento;
  if (!mensagem.fromMe) return "cliente";

  if (String(mensagem.body || "").startsWith(MARCA_DO_BOT)) return "bot";
  if (ORIGENS_AUTOMATICAS.has(mensagem.source)) return "bot";
  if (mensagem.source === "agent") return "atendente";

  if (!ticket?.userId || (ticket?.status && ticket.status !== "open")) return "bot";
  return "atendente";
}

/** Rótulo da mídia no chamado, pelo `mediaType` (o banco grava "image", o SDK documenta "imageMessage"). */
function rotuloDaMidia(mensagem: any): string | null {
  const tipo = String(mensagem?.mediaType || "").toLowerCase();
  const mime = String(mensagem?.media?.mimetype || "").toLowerCase();

  if (tipo.startsWith("sticker")) return "Figurinha";
  if (tipo.startsWith("image") || (!tipo && mime.startsWith("image/"))) return "Imagem";
  if (tipo.startsWith("audio") || tipo.startsWith("ptt")) return "Áudio";
  if (tipo.startsWith("video") || tipo.startsWith("ptv")) return "Vídeo";
  if (tipo.startsWith("document") || tipo.startsWith("application")) return "Arquivo";
  if (tipo.startsWith("location")) return "Localização";
  if (tipo.startsWith("contact") || tipo.startsWith("vcard")) return "Contato";
  if (temMidia(mensagem)) return "Arquivo";
  return null;
}

/**
 * A URL do arquivo, quando há um.
 *
 * O backend atual manda `media.url` absoluta. `mediaUrl` cru só serve se já
 * for absoluto — o nome de arquivo solto (backend antigo) não diz de onde
 * baixar.
 */
function urlDaMidia(mensagem: any): string | null {
  const url = mensagem?.media?.url || mensagem?.mediaUrl;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function temMidia(mensagem: any): boolean {
  return !!urlDaMidia(mensagem);
}

/** Texto limpo: sem a marca invisível do bot, que no TomTicket vira lixo no começo da linha. */
function textoDa(mensagem: any): string {
  return String(mensagem?.body || "").split(MARCA_DO_BOT).join("").trim();
}

/** Nome do arquivo como o Markedesk gravou, sem o encode da URL. */
function nomeDoArquivo(mensagem: any, url: string): string {
  const bruto = mensagem?.media?.filename || url.split("?")[0].split("/").pop() || "arquivo";
  try {
    return decodeURIComponent(bruto);
  } catch {
    return bruto;
  }
}

/**
 * O texto que representa a mensagem no chamado.
 *
 * Mídia entra como "[Imagem]", "[Áudio]"... seguido da legenda, se houver. A
 * legenda ausente costuma chegar como o próprio nome do arquivo no `body` —
 * repetir isso ao lado do anexo só polui. `anexada: false` avisa no texto que
 * o arquivo não foi junto, para ninguém procurá-lo no chamado.
 */
export function corpoDaMensagem(mensagem: any, anexada = true): string {
  const texto = textoDa(mensagem);
  const rotulo = rotuloDaMidia(mensagem);

  if (!rotulo) return texto || "[mensagem sem texto]";

  const url = urlDaMidia(mensagem);
  const legenda = url && texto === nomeDoArquivo(mensagem, url) ? "" : texto;

  // Localização e contato não têm arquivo: o conteúdo está no próprio texto.
  const semArquivo = rotulo === "Localização" || rotulo === "Contato";
  const aviso = !semArquivo && !anexada ? " (arquivo não anexado — ver no Markedesk)" : "";

  return legenda ? `[${rotulo}${aviso}] ${legenda}` : `[${rotulo}${aviso}]`;
}

/**
 * Baixa a mídia da mensagem para anexar no chamado.
 *
 * `null` quando não há arquivo ou ele não pôde vir — o chamado ainda recebe o
 * texto, com o aviso de `corpoDaMensagem`. A pasta `/public` do backend é
 * aberta, então não precisa de credencial.
 */
export async function baixarAnexo(mensagem: any): Promise<Anexo | null> {
  const url = urlDaMidia(mensagem);
  if (!url) return null;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      console.error(`${LOG} mídia ${url} respondeu HTTP ${res.status} — vai sem anexo.`);
      return null;
    }

    const tamanhoDeclarado = Number(res.headers.get("content-length") || 0);
    if (tamanhoDeclarado > LIMITE_ANEXO) {
      await res.body?.cancel();
      console.warn(`${LOG} mídia ${url} tem ${tamanhoDeclarado} bytes, acima do limite do TomTicket — vai sem anexo.`);
      return null;
    }

    const dados = await res.blob();
    if (dados.size > LIMITE_ANEXO) {
      console.warn(`${LOG} mídia ${url} tem ${dados.size} bytes, acima do limite do TomTicket — vai sem anexo.`);
      return null;
    }

    const tipo = mensagem?.media?.mimetype || res.headers.get("content-type") || dados.type;
    return {
      nome: nomeDoArquivo(mensagem, url),
      dados: tipo && tipo !== dados.type ? new Blob([dados], { type: tipo }) : dados
    };
  } catch (err: any) {
    console.error(`${LOG} falha ao baixar a mídia ${url}: ${err?.message || err} — vai sem anexo.`);
    return null;
  }
}
