import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { abrirBanco, type Banco } from "@/db/banco";
import { RepositorioEventos, ehDeChamado, type Evento } from "@/db/eventos";

let banco: Banco;
let repo: RepositorioEventos;

beforeEach(() => {
  banco = abrirBanco(":memory:");
  repo = new RepositorioEventos(banco);
});
afterEach(() => banco.close());

const evento = (nivel: Evento["nivel"], texto: string, quando = new Date().toISOString()): Evento => ({
  quando,
  nivel,
  texto
});

describe("ehDeChamado", () => {
  it("reconhece as linhas de abertura e de finalização de chamado", () => {
    // As mesmas marcas que a aba Diagnóstico usava na expressão regular — só
    // que agora decididas na gravação, não na tela.
    expect(ehDeChamado("ticket 42 → chamado 74128")).toBe(true);
    expect(ehDeChamado("chamado 74128 finalizado pelo ticket 42")).toBe(true);
  });

  it("não marca log comum", () => {
    expect(ehDeChamado("fila 7 não mapeada — chamado não criado")).toBe(false);
    expect(ehDeChamado("token do TomTicket não configurado")).toBe(false);
  });
});

describe("registrar e listar", () => {
  it("devolve os mais recentes primeiro", () => {
    repo.registrar(evento("info", "primeiro"));
    repo.registrar(evento("info", "segundo"));
    expect(repo.listar("tudo").map(e => e.texto)).toEqual(["segundo", "primeiro"]);
  });

  it("o filtro 'problemas' deixa o info de fora", () => {
    repo.registrar(evento("info", "rotina"));
    repo.registrar(evento("aviso", "sem email no contato"));
    repo.registrar(evento("erro", "token inválido"));

    const textos = repo.listar("problemas").map(e => e.texto);
    expect(textos).toContain("sem email no contato");
    expect(textos).toContain("token inválido");
    expect(textos).not.toContain("rotina");
  });

  it("o filtro 'chamados' traz só as linhas de chamado", () => {
    repo.registrar(evento("info", "ticket 42 → chamado 74128"));
    repo.registrar(evento("info", "atendente vinculado"));
    expect(repo.listar("chamados").map(e => e.texto)).toEqual(["ticket 42 → chamado 74128"]);
  });

  it("respeita o limite pedido e apara o absurdo", () => {
    for (let i = 0; i < 50; i++) repo.registrar(evento("erro", `e${i}`));
    expect(repo.listar("tudo", 10).length).toBe(10);
    expect(repo.listar("tudo", 99999).length).toBe(50);
  });
});

describe("contagens", () => {
  it("conta sobre a tabela inteira, não sobre a página devolvida", () => {
    // É o bug que o banco corrige: a aba baixava 200 eventos e contava os
    // problemas entre eles, então o número no chip não era quantos existem.
    for (let i = 0; i < 400; i++) repo.registrar(evento("erro", `e${i}`));
    repo.registrar(evento("info", "ticket 1 → chamado 9"));

    const c = repo.contagens();
    expect(c.problemas).toBe(400);
    expect(c.chamados).toBe(1);
    expect(c.tudo).toBe(401);
    // A página é menor que o total — e a contagem não se confunde com ela.
    expect(repo.listar("problemas", 50).length).toBe(50);
  });
});

describe("registrarVarios", () => {
  it("grava o lote inteiro", () => {
    repo.registrarVarios([evento("info", "a"), evento("erro", "b")]);
    expect(repo.contagens().tudo).toBe(2);
  });

  it("lote vazio não faz nada", () => {
    expect(() => repo.registrarVarios([])).not.toThrow();
    expect(repo.contagens().tudo).toBe(0);
  });
});

describe("podar", () => {
  it("apaga o que passou da idade de retenção", () => {
    const antigo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    repo.registrar(evento("erro", "de um mês atrás", antigo));
    repo.registrar(evento("erro", "de agora"));

    expect(repo.podar()).toBeGreaterThan(0);
    expect(repo.listar("tudo").map(e => e.texto)).toEqual(["de agora"]);
  });

  it("apaga o excedente mantendo os mais novos", () => {
    // O teto é 5000; com 5010 sobram os 5000 últimos.
    const muitos = Array.from({ length: 5_010 }, (_, i) => evento("info", `e${i}`));
    repo.registrarVarios(muitos);
    repo.podar();

    const total = Number(banco.prepare("SELECT COUNT(*) AS n FROM eventos").get().n);
    expect(total).toBe(5_000);
    // O mais recente sobrevive; o mais antigo, não.
    expect(repo.listar("tudo", 1)[0].texto).toBe("e5009");
    expect(repo.listar("tudo", 5_000).some(e => e.texto === "e0")).toBe(false);
  });

  it("não apaga nada quando está dentro dos limites", () => {
    repo.registrar(evento("info", "recente"));
    expect(repo.podar()).toBe(0);
  });
});
