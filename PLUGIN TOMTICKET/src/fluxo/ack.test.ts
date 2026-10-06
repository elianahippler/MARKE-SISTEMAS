import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { abrirBanco, type Banco } from "@/db/banco";
import { RepositorioVinculos } from "@/db/vinculos";
import { RepositorioPendentes } from "@/db/pendentes";
import { FluxoChamados } from "@/fluxo/chamados";
import { ESPERA_PELO_ACK_MS, IDADE_PARA_CONFERIR_MS } from "@/ack";

/**
 * A regra desta versão: a resposta do atendente só vai ao chamado depois que o
 * WhatsApp confirma que ela saiu.
 *
 * Os testes olham a FILA, não o TomTicket: sem token configurado, o fluxo
 * desiste antes de chamar a API. É o suficiente, porque o que se quer provar é
 * quem entra na fila, quem sai e em que ordem — e não o formato do que a API
 * recebe, que já é o caminho antigo, inalterado.
 */

let banco: Banco;
let pendentes: RepositorioPendentes;
let fluxo: FluxoChamados;

// Sem token de TomTicket, o fluxo para antes de chamar a API do TomTicket.
// O `client` é o do Markedesk: é por ele que o plugin confere o ack real.
let mensagensNoBackend: any[] = [];
let servidorSemToken: any;

beforeEach(() => {
  mensagensNoBackend = [];
  servidorSemToken = {
    client: { listMessages: async () => mensagensNoBackend }
  };
  banco = abrirBanco(":memory:");
  pendentes = new RepositorioPendentes(banco);
  fluxo = new FluxoChamados(servidorSemToken, new RepositorioVinculos(banco), pendentes);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  banco.close();
});

const enviada = (id: number, ack = 0, extra: Record<string, unknown> = {}) => ({
  ticket: { id: 101 },
  message: { id, body: `mensagem ${id}`, ack, ...extra },
  companyId: 1
});

describe("a resposta do atendente espera o ack", () => {
  it("fica na fila enquanto o ack é 0 — não vai ao chamado", async () => {
    // É o bug que isto corrige: o evento dispara quando o Markedesk GRAVA a
    // mensagem, e até a 0.3.1 o chamado registrava resposta que o cliente
    // nunca recebeu.
    await fluxo.aoMensagem(enviada(1), "atendente");
    expect(pendentes.ler(1)).not.toBeNull();
    expect(pendentes.ler(1)!.confirmada).toBe(false);
  });

  it("com ack já confirmado, não enfileira — espelha na hora", async () => {
    await fluxo.aoMensagem(enviada(1, 1), "atendente");
    expect(pendentes.ler(1)).toBeNull();
  });

  it("ack 2 (entregue) também passa direto", async () => {
    await fluxo.aoMensagem(enviada(1, 2), "atendente");
    expect(pendentes.ler(1)).toBeNull();
  });

  it("nota interna não espera — ela não vai ao WhatsApp e nunca teria ack", async () => {
    await fluxo.aoMensagem(enviada(1, 0, { isPrivate: true }), "atendente");
    expect(pendentes.ler(1)).toBeNull();
  });

  it("mensagem do cliente não espera — já chegou", async () => {
    await fluxo.aoMensagem(enviada(1), "cliente");
    expect(pendentes.quantas()).toBe(0);
  });

  it("sem id de mensagem, espelha na hora em vez de sumir", async () => {
    // Sem id não há como casar o ack depois. Registrar sem confirmação é
    // menos ruim que a resposta não aparecer no chamado nunca.
    await fluxo.aoMensagem({ ticket: { id: 101 }, message: { body: "x" }, companyId: 1 }, "atendente");
    expect(pendentes.quantas()).toBe(0);
  });

  it("que já nasceu falhada não entra na fila nem no chamado", async () => {
    await fluxo.aoMensagem(enviada(1, -1), "atendente");
    expect(pendentes.quantas()).toBe(0);
  });
});

describe("quando o ack chega", () => {
  it("confirma e tira da fila", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    await fluxo.aoAck({ message: { id: 1 }, ticket: { id: 101 }, ack: 1, companyId: 1 });
    expect(pendentes.ler(1)).toBeNull();
  });

  it("ack 0 não libera nada", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    await fluxo.aoAck({ message: { id: 1 }, ticket: { id: 101 }, ack: 0, companyId: 1 });
    expect(pendentes.ler(1)).not.toBeNull();
  });

  it("ack -1 descarta: não saiu, não entra no chamado", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    await fluxo.aoAck({ message: { id: 1 }, ticket: { id: 101 }, ack: -1, companyId: 1 });
    expect(pendentes.ler(1)).toBeNull();
  });

  it("ack de mensagem que não está na fila é ignorado", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    await fluxo.aoAck({ message: { id: 777 }, ticket: { id: 101 }, ack: 1, companyId: 1 });
    expect(pendentes.ler(1)).not.toBeNull();
  });

  it("message:failed descarta igual", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    await fluxo.aoFalhaDeEnvio({ message: { id: 1 }, ticket: { id: 101 }, erro: "sem conexão" });
    expect(pendentes.ler(1)).toBeNull();
  });
});

describe("a ordem da conversa", () => {
  it("a segunda confirmada antes da primeira ESPERA a primeira", async () => {
    // O WhatsApp confirma fora de ordem. Espelhar na ordem da confirmação
    // inverteria as frases para quem lê o chamado depois.
    await fluxo.aoMensagem(enviada(1), "atendente");
    await fluxo.aoMensagem(enviada(2), "atendente");

    await fluxo.aoAck({ message: { id: 2 }, ticket: { id: 101 }, ack: 1, companyId: 1 });

    expect(pendentes.ler(1)).not.toBeNull();
    expect(pendentes.ler(2)).not.toBeNull();
    expect(pendentes.ler(2)!.confirmada).toBe(true);
  });

  it("confirmada a primeira, as duas saem de uma vez e na ordem", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    await fluxo.aoMensagem(enviada(2), "atendente");
    await fluxo.aoAck({ message: { id: 2 }, ticket: { id: 101 }, ack: 1, companyId: 1 });

    await fluxo.aoAck({ message: { id: 1 }, ticket: { id: 101 }, ack: 1, companyId: 1 });

    expect(pendentes.quantas()).toBe(0);
  });

  it("a fila de um ticket não segura a de outro", async () => {
    await fluxo.aoMensagem({ ...enviada(1), ticket: { id: 101 } }, "atendente");
    await fluxo.aoMensagem({ ...enviada(2), ticket: { id: 202 } }, "atendente");

    await fluxo.aoAck({ message: { id: 2 }, ticket: { id: 202 }, ack: 1, companyId: 1 });

    expect(pendentes.ler(2)).toBeNull();
    expect(pendentes.ler(1)).not.toBeNull();
  });
});

describe("conferência ativa do ack (não depende do evento)", () => {
  const envelhecer = (id: number, ms: number) =>
    banco
      .prepare("UPDATE pendentes SET quando = ? WHERE mensagem_id = ?")
      .run(new Date(Date.now() - ms).toISOString(), String(id));

  it("confirma lendo o ack real no backend, sem nenhum evento de ack", async () => {
    // É o bug da 0.4.0: os hooks novos não chegavam ao plugin, nada confirmava
    // e as respostas sumiam do chamado enquanto chegavam no WhatsApp.
    await fluxo.aoMensagem(enviada(1), "atendente");
    envelhecer(1, IDADE_PARA_CONFERIR_MS + 1000);
    mensagensNoBackend = [{ id: 1, ack: 1 }];

    await fluxo.verificarPendentes();

    expect(pendentes.ler(1)).toBeNull();
  });

  it("ack ainda 0 e dentro do prazo: continua esperando", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    envelhecer(1, IDADE_PARA_CONFERIR_MS + 1000);
    mensagensNoBackend = [{ id: 1, ack: 0 }];

    await fluxo.verificarPendentes();

    expect(pendentes.ler(1)).not.toBeNull();
  });

  it("ack -1 no backend: descarta", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    envelhecer(1, IDADE_PARA_CONFERIR_MS + 1000);
    mensagensNoBackend = [{ id: 1, ack: -1 }];

    await fluxo.verificarPendentes();

    expect(pendentes.ler(1)).toBeNull();
  });

  it("passou dos 90s com ack 0: descarta e registra", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    envelhecer(1, ESPERA_PELO_ACK_MS + 1000);
    mensagensNoBackend = [{ id: 1, ack: 0 }];

    await fluxo.verificarPendentes();

    expect(pendentes.ler(1)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("sem confirmação do WhatsApp"));
  });

  it("nova demais para conferir: não consulta nem decide", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    mensagensNoBackend = [{ id: 1, ack: 1 }];

    await fluxo.verificarPendentes();

    expect(pendentes.ler(1)).not.toBeNull();
  });

  it("backend fora do ar não descarta nada — tenta de novo depois", async () => {
    // Descartar aqui perderia uma resposta que provavelmente saiu.
    await fluxo.aoMensagem(enviada(1), "atendente");
    envelhecer(1, ESPERA_PELO_ACK_MS + 1000);
    servidorSemToken.client.listMessages = async () => {
      throw new Error("backend fora");
    };

    await fluxo.verificarPendentes();

    expect(pendentes.ler(1)).not.toBeNull();
  });

  it("confirma na ordem: a segunda só sai depois da primeira", async () => {
    await fluxo.aoMensagem(enviada(1), "atendente");
    await fluxo.aoMensagem(enviada(2), "atendente");
    envelhecer(1, IDADE_PARA_CONFERIR_MS + 1000);
    envelhecer(2, IDADE_PARA_CONFERIR_MS + 1000);
    mensagensNoBackend = [{ id: 1, ack: 0 }, { id: 2, ack: 1 }];

    await fluxo.verificarPendentes();

    expect(pendentes.ler(1)).not.toBeNull();
    expect(pendentes.ler(2)).not.toBeNull();
    expect(pendentes.ler(2)!.confirmada).toBe(true);
  });
});
