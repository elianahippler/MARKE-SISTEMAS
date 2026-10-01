/**
 * Ícone oficial do TomTicket (favicon 32x32 de tomticket.com), embutido.
 *
 * Embutido, e não apontando para o site deles: o botão aparece em todo
 * atendimento, e depender do site do TomTicket para desenhá-lo traria uma
 * requisição externa a cada tela (e um ícone quebrado se o endereço mudar).
 *
 * Só serve onde o PLUGIN desenha (o botão "Finalizar Chamado"): o ícone do
 * card do plugin no Markedesk é escolhido numa lista fechada de símbolos, sem
 * suporte a imagem — lá vai o "Chat" na cor do TomTicket (ver metadata.ts).
 */
export const LOGO_TOMTICKET = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAACFUlEQVR42u3XPWgTYRzH8UtTpDRDBIUMDq1CS/qCZlDUwVaMFF8gRAQpQQcnN0U6dRLBbgodFMlkioNLXdTJbq4ugpu4tENp09LSNm1J0uTf7wP/gyNc0rfnrksf+JDw/Ln8fhx3F845WWat5zJtiONsSOJoc8MTeIPf+BsGzZpAwhQooAZBPSSimQVToIQa3iGDBxZkkcNDZBtmGbzVzJKjbbYwbPGa6sE3PG0yH9ZMCarAfdTxeSOXidgpYP8MbHoLbGPEYoEo+nC6yXwE226BHQimEbdU4DL+45XPLK5Zgh2zMY4VVPHYUoG7qGGq1HANmAxUNXPcbLSjAEHeUoEEXuOWzywP0cx2d3MSgilELBTowG10NexHNEMw6W6m8Q+CMUtn4CZKeO8zG4NoZtpsFCH4g/OWCqRRRt5ndkGzBEVHv1QwavE2jCGL3ibzUVSCfBCdwUtcb/UgCrLAHdTw6bj+C65iDhP7OQNlVPECSQyoQfSj03PgKfTqbKCFFB5hyGeWxHPNLJsf/ek5C8seS5jFNQ2P6oHzOt/LIpb8ZpolmHG01TQWsarWUMcmbmiBZ+6+fq4eQRFfMei9bZJI4SLuYUGbDuEJViD4giu4hNQh9SHW6iLqxpwW+KBlRFsnnICXt4CgAsEPnDPzUAuoGXQ7h18RRA9SoAuzEPxCT9hvSjF8xHf0H9frWgc6T15cg1675NiTg6TogP0AAAAASUVORK5CYII=";

/** Cor da marca (theme-color do site do TomTicket). */
export const COR_TOMTICKET = "#F76045";

/**
 * Contorno e fundo do botão "Finalizar Chamado": a cor da marca suavizada.
 * Com a cor cheia, o botão disputaria atenção com o "Resolver" do lado.
 */
export const BORDA_TOMTICKET = "rgba(247, 96, 69, 0.55)";
export const FUNDO_TOMTICKET = "rgba(247, 96, 69, 0.06)";
