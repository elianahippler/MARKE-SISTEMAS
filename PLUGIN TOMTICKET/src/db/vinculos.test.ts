import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { abrirBanco, type Banco } from "@/db/banco";
import { RepositorioVinculos, type VinculoChamado } from "@/db/vinculos";

let banco: Banco;
let repo: RepositorioVinculos;

beforeEach(() => {
  banco = abrirBanco(":memory:");
  repo = new RepositorioVinculos(banco);
});
afterEach(() => banco.close());

const VINCULO: VinculoChamado = {
  chamadoId: "bd86efff6ef2bf3da0433c4ef1940f69",
  protocolo: "74128",
  departamentoId: "dep-1",
  operadorAtual: "op-1",
  clienteEmail: "cliente@exemplo.com",
  filaId: "7"
};

describe("gravar e ler", () => {
  it("grava e devolve o vínculo inteiro", () => {
    repo.gravar(101, VINCULO);
    const lido = repo.ler(101);

    expect(lido).toMatchObject(VINCULO);
    expect(lido!.ticketId).toBe("101");
  });

  it("aceita ticket como número ou string — é o mesmo vínculo", () => {
    // O id chega como número pelos hooks e como string pelas rotas; se os dois
    // não caíssem na mesma linha, a tela e o fluxo veriam vínculos diferentes.
    repo.gravar(101, VINCULO);
    expect(repo.ler("101")?.chamadoId).toBe(VINCULO.chamadoId);
  });

  it("devolve null para ticket que nunca virou chamado", () => {
    expect(repo.ler(999)).toBeNull();
  });

  it("campo ausente volta como undefined, não como null", () => {
    // O fluxo testa `if (vinculo.departamentoPendente)`; vindo `null` do banco
    // funcionaria, mas o tipo diz `string | undefined` — deixar o null passar
    // vazaria o formato da coluna para o resto do plugin.
    repo.gravar(101, { chamadoId: "ch", clienteEmail: "a@b.c" });
    const lido = repo.ler(101)!;
    expect(lido.protocolo).toBeUndefined();
    expect(lido.departamentoPendente).toBeUndefined();
    expect(lido.filaId).toBeUndefined();
  });

  it("finalizado vira booleano de verdade, não 0/1", () => {
    repo.gravar(101, { ...VINCULO, finalizado: true, finalizadoPor: "resolvido" });
    const lido = repo.ler(101)!;
    expect(lido.finalizado).toBe(true);
    expect(lido.finalizadoPor).toBe("resolvido");

    repo.gravar(102, VINCULO);
    expect(repo.ler(102)!.finalizado).toBe(false);
  });
});

describe("gravar de novo (upsert)", () => {
  it("atualiza sem criar outra linha", () => {
    repo.gravar(101, VINCULO);
    repo.gravar(101, { ...VINCULO, operadorAtual: "op-2", finalizado: true });

    expect(Number(banco.prepare("SELECT COUNT(*) AS n FROM vinculos").get().n)).toBe(1);
    expect(repo.ler(101)!.operadorAtual).toBe("op-2");
    expect(repo.ler(101)!.finalizado).toBe(true);
  });

  it("preserva criado_em — é a data em que o chamado foi aberto", () => {
    // O fluxo regrava o vínculo a cada mensagem. Se o upsert sobrescrevesse
    // criado_em, a única informação de quando o atendimento começou viraria
    // "agora" em toda mensagem.
    repo.gravar(101, VINCULO);
    const nascimento = repo.ler(101)!.criadoEm;

    banco.prepare("UPDATE vinculos SET criado_em = ? WHERE ticket_id = ?").run("2020-01-01T00:00:00.000Z", "101");
    repo.gravar(101, { ...VINCULO, operadorAtual: "op-9" });

    expect(repo.ler(101)!.criadoEm).toBe("2020-01-01T00:00:00.000Z");
    expect(repo.ler(101)!.criadoEm).not.toBe(nascimento);
  });

  it("move atualizado_em para frente", () => {
    repo.gravar(101, VINCULO);
    banco.prepare("UPDATE vinculos SET atualizado_em = ? WHERE ticket_id = ?").run("2020-01-01T00:00:00.000Z", "101");
    repo.gravar(101, VINCULO);
    expect(repo.ler(101)!.atualizadoEm).not.toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("o que vinha da tabela comunica", () => {
  // Categoria, mensagem e canal só existiam no POST para o n8n até a 0.2.0.
  // Agora são colunas: se não voltarem da leitura, o dado some sem ninguém ver.
  const COMPLETO: VinculoChamado = {
    ...VINCULO,
    categoriaId: "cat-9",
    mensagem: "Bom dia, preciso de ajuda com o boleto",
    canal: "whatsapp"
  };

  it("grava e devolve categoria, mensagem e canal", () => {
    repo.gravar(101, COMPLETO);
    expect(repo.ler(101)).toMatchObject({
      categoriaId: "cat-9",
      mensagem: "Bom dia, preciso de ajuda com o boleto",
      canal: "whatsapp"
    });
  });

  it("sobrevive ao regravar — o fluxo relê e regrava o objeto inteiro", () => {
    // Toda atualização (transferência, atendente, finalização) passa pelo
    // mesmo upsert. Como o fluxo relê o vínculo antes de mexer, os três campos
    // viajam junto; esta é a garantia de que o caminho de volta não os perde.
    repo.gravar(101, COMPLETO);
    const lido = repo.ler(101)!;
    repo.gravar(101, { ...lido, operadorAtual: "op-2" });

    expect(repo.ler(101)).toMatchObject({
      categoriaId: "cat-9",
      mensagem: "Bom dia, preciso de ajuda com o boleto",
      canal: "whatsapp",
      operadorAtual: "op-2"
    });
  });

  it("vínculo antigo, de antes da migração, fica com os três vazios", () => {
    // ADD COLUMN deixa NULL nas linhas que já existiam — e NULL é a verdade:
    // para elas o plugin nunca soube esses valores.
    repo.gravar(101, VINCULO);
    const lido = repo.ler(101)!;
    expect(lido.categoriaId).toBeUndefined();
    expect(lido.mensagem).toBeUndefined();
    expect(lido.canal).toBeUndefined();
  });
});

describe("listar", () => {
  beforeEach(() => {
    repo.gravar(1, { ...VINCULO, protocolo: "111" });
    repo.gravar(2, { ...VINCULO, protocolo: "222", finalizado: true });
    repo.gravar(3, { ...VINCULO, protocolo: "333" });
  });

  it("traz tudo por padrão", () => {
    expect(repo.listar().length).toBe(3);
  });

  it("acha o ticket pelo protocolo — o caminho que o chave-valor não tinha", () => {
    const [achado] = repo.listar({ protocolo: "222" });
    expect(achado.ticketId).toBe("2");
  });

  it("acha também pelo hash do chamado, que é o que a API usa", () => {
    expect(repo.listar({ protocolo: VINCULO.chamadoId }).length).toBe(3);
  });

  it("filtra só os abertos", () => {
    const abertos = repo.listar({ apenasAbertos: true });
    expect(abertos.map(v => v.ticketId).sort()).toEqual(["1", "3"]);
  });

  it("respeita o limite e nunca devolve a tabela inteira", () => {
    expect(repo.listar({ limite: 2 }).length).toBe(2);
    // Limite absurdo é aparado: a tela não pode travar o navegador por descuido.
    expect(repo.listar({ limite: 99999 }).length).toBe(3);
  });
});

describe("transcrições", () => {
  beforeEach(() => repo.gravar(101, VINCULO));

  it("marca e reconhece um áudio já transcrito", () => {
    expect(repo.jaTranscrito(101, "wid-1")).toBe(false);
    repo.marcarTranscrito(101, "wid-1");
    expect(repo.jaTranscrito(101, "wid-1")).toBe(true);
  });

  it("marcar duas vezes não lança", () => {
    // Duas transcrições do mesmo áudio chegando juntas não podem virar
    // 'UNIQUE constraint failed' no meio do atendimento.
    repo.marcarTranscrito(101, "wid-1");
    expect(() => repo.marcarTranscrito(101, "wid-1")).not.toThrow();
    expect(Number(banco.prepare("SELECT COUNT(*) AS n FROM transcricoes").get().n)).toBe(1);
  });

  it("não há teto de áudios por chamado", () => {
    // Como array no vínculo, o teto era 50 (MAXIMO_TRANSCRITOS) e o 51º áudio
    // empurrava o 1º para fora — podendo ser transcrito de novo.
    for (let i = 0; i < 120; i++) repo.marcarTranscrito(101, `wid-${i}`);
    expect(repo.jaTranscrito(101, "wid-0")).toBe(true);
    expect(repo.jaTranscrito(101, "wid-119")).toBe(true);
  });

  it("áudio de um chamado não conta como transcrito em outro", () => {
    repo.gravar(202, VINCULO);
    repo.marcarTranscrito(101, "wid-1");
    expect(repo.jaTranscrito(202, "wid-1")).toBe(false);
  });
});
