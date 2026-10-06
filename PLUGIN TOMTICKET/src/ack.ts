/**
 * O ack do WhatsApp — a confirmação de que a mensagem saiu.
 *
 * ## Por que o plugin precisa disso
 *
 * O evento `ticket:messageSent` dispara quando o Markedesk GRAVA a mensagem,
 * não quando o WhatsApp a aceita. Entre os dois há uma rede: a mensagem pode
 * ficar presa em `ack 0` e nunca sair, ou voltar como `-1`. Espelhando no
 * TomTicket na hora do evento, o chamado passa a registrar uma resposta que o
 * cliente nunca recebeu — e ninguém percebe, porque no chamado está lá.
 *
 * Por isso a resposta do atendente espera o ack. Ver `RepositorioPendentes`.
 *
 * ## A escala
 *
 * Conferida no frontend (`MessagesList`), que é o que o atendente vê:
 *
 * | ack | o que é | na tela |
 * |-----|---------|---------|
 * | -1  | falhou  | vermelho, com "Reenviar" |
 * | 0   | pendente, ainda não saiu | relógio |
 * | 1   | o servidor do WhatsApp recebeu | um tique |
 * | 2,3 | entregue no aparelho | dois tiques |
 * | 4,5 | lida / áudio tocado | dois tiques coloridos |
 *
 * O critério do plugin é `>= 1`: o servidor do WhatsApp aceitou. Exigir 2
 * (entregue) travaria o chamado sempre que o cliente estivesse com o celular
 * desligado — a mensagem saiu, e é isso que o chamado precisa registrar.
 */

/** Falhou no envio. O atendente vê o balão vermelho. */
export const ACK_FALHOU = -1;

/** Mínimo para considerar que a mensagem saiu. */
export const ACK_ENVIADA = 1;

/**
 * Quanto esperar pelo ack antes de desistir.
 *
 * Mesmos 90 s que o frontend usa para pintar de vermelho a mensagem presa em
 * `ack 0` (`ACK_STUCK_TIMEOUT_MS`). Dois critérios diferentes para "esta não
 * saiu" dariam telas que se contradizem: o balão vermelho para o atendente e
 * a resposta registrada no chamado.
 */
export const ESPERA_PELO_ACK_MS = 90_000;

/**
 * Idade a partir da qual vale conferir o ack real no backend.
 *
 * O evento `message:ackChanged` é o caminho rápido, mas ele só chega se o
 * backend tiver registrado esse hook do plugin — e isso acontece quando o
 * plugin é CARREGADO, não quando o container sobe com um metadata novo. A 0.4.0
 * confiou só no evento e as respostas sumiram do chamado em produção.
 *
 * Por isso a conferência ativa, por `listMessages`. 5 s é tempo de o WhatsApp
 * responder no caso normal: antes disso quase toda consulta veria `ack 0` e
 * seria consulta à toa.
 */
export const IDADE_PARA_CONFERIR_MS = 5_000;

export function confirmaEnvio(ack: unknown): boolean {
  return typeof ack === "number" && ack >= ACK_ENVIADA;
}

export function falhouNoEnvio(ack: unknown): boolean {
  return ack === ACK_FALHOU;
}
