import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { abrirBanco, type Banco } from "@/db/banco";
import { RepositorioPendentes } from "@/db/pendentes";
import { ESPERA_PELO_ACK_MS } from "@/ack";

let banco: Banco;
let repo: RepositorioPendentes;

beforeEach(() => {
  banco = abrirBanco(":memory:");
  repo = new RepositorioPendentes(banco);
});
afterEach(() => banco.close());

const evento = (id: number, texto = "oi") => ({
  ticket: { id: 101 },
  message: { id, body: texto, ack: 0 },
  companyId: 1
});

/** Envelhece a linha, para não depender do relógio nos testes de expiração. */
function envelhecer(mensagemId: string | number, ms: number): void {
  banco
    .prepare("UPDATE pendentes SET quando = ? WHERE mensagem_id = ?")
    .run(new Date(Date.now() - ms).toISOString(), String(mensagemId));
}

describe("enfileirar e ler", () => {
  it("guarda o payload inteiro do evento", () => {
    repo.enfileirar(1, 101, evento(1, "bom dia"));
    const p = repo.ler(1);
    expect(p!.ticketId).toBe("101");
    expect(p!.dados.message.body).toBe("bom dia");
    expect(p!.confirmada).toBe(false);
  });

  it("devolve null para mensagem que não está na fila", () => {
    expect(repo.ler(999)).toBeNull();
  });

  it("o mesmo evento duas vezes não vira duas respostas", () => {
    // O backend pode reemitir (reconexão do canal). Duas linhas seriam a
    // mesma frase duas vezes no chamado, para o cliente ler.
    repo.enfileirar(1, 101, evento(1));
    repo.enfileirar(1, 101, evento(1));
    expect(repo.quantas()).toBe(1);
  });

  it("linha com JSON quebrado é descartada, sem derrubar a fila do ticket", () => {
    repo.enfileirar(1, 101, evento(1));
    repo.enfileirar(2, 101, evento(2));
    banco.prepare("UPDATE pendentes SET dados = ? WHERE mensagem_id = ?").run("{nao é json", "1");
    const fila = repo.doTicket(101);
    expect(fila).toHaveLength(1);
    expect(fila[0].mensagemId).toBe("2");
  });
});

describe("confirmar", () => {
  it("marca só a mensagem confirmada", () => {
    repo.enfileirar(1, 101, evento(1));
    repo.enfileirar(2, 101, evento(2));
    repo.confirmar(1);
    expect(repo.ler(1)!.confirmada).toBe(true);
    expect(repo.ler(2)!.confirmada).toBe(false);
  });

  it("a marca sobrevive — é coluna, não estado em memória", () => {
    // Um restart entre a confirmação e o espelhamento perderia um Set em
    // memória: a resposta já teria saído no WhatsApp e nunca entraria no
    // chamado. Reabrir o repositório sobre o mesmo banco simula isso.
    repo.enfileirar(1, 101, evento(1));
    repo.confirmar(1);
    expect(new RepositorioPendentes(banco).ler(1)!.confirmada).toBe(true);
  });
});

describe("doTicket", () => {
  it("devolve na ordem em que foram escritas", () => {
    // O chamado é uma conversa: o WhatsApp confirma fora de ordem, e espelhar
    // na ordem da confirmação inverteria as frases.
    repo.enfileirar(1, 101, evento(1, "primeira"));
    repo.enfileirar(2, 101, evento(2, "segunda"));
    repo.enfileirar(3, 101, evento(3, "terceira"));
    expect(repo.doTicket(101).map(p => p.dados.message.body)).toEqual(["primeira", "segunda", "terceira"]);
  });

  it("não mistura tickets", () => {
    repo.enfileirar(1, 101, evento(1));
    repo.enfileirar(2, 202, evento(2));
    expect(repo.doTicket(101)).toHaveLength(1);
    expect(repo.doTicket(202)).toHaveLength(1);
  });

  it("aceita o ticket como número ou texto", () => {
    repo.enfileirar(1, 101, evento(1));
    expect(repo.doTicket("101")).toHaveLength(1);
  });
});

describe("expiradas", () => {
  it("traz as que passaram do tempo de espera", () => {
    repo.enfileirar(1, 101, evento(1));
    repo.enfileirar(2, 101, evento(2));
    envelhecer(1, ESPERA_PELO_ACK_MS + 1000);
    const vencidas = repo.expiradas(ESPERA_PELO_ACK_MS);
    expect(vencidas).toHaveLength(1);
    expect(vencidas[0].mensagemId).toBe("1");
  });

  it("não traz as que ainda estão dentro do prazo", () => {
    repo.enfileirar(1, 101, evento(1));
    envelhecer(1, ESPERA_PELO_ACK_MS - 5000);
    expect(repo.expiradas(ESPERA_PELO_ACK_MS)).toHaveLength(0);
  });

  it("expira mesmo já confirmada — quem foi espelhada sai da fila", () => {
    // Confirmada e ainda na fila depois do prazo significa que o
    // espelhamento não aconteceu (travou, ou o processo caiu). Fica visível
    // na varredura em vez de ficar na tabela para sempre.
    repo.enfileirar(1, 101, evento(1));
    repo.confirmar(1);
    envelhecer(1, ESPERA_PELO_ACK_MS + 1000);
    expect(repo.expiradas(ESPERA_PELO_ACK_MS)).toHaveLength(1);
  });
});

describe("remover", () => {
  it("tira da fila", () => {
    repo.enfileirar(1, 101, evento(1));
    repo.remover(1);
    expect(repo.ler(1)).toBeNull();
    expect(repo.quantas()).toBe(0);
  });

  it("remover o que não existe não lança", () => {
    expect(() => repo.remover(999)).not.toThrow();
  });
});
