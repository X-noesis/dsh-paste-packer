/**
 * Host half of dsh-paste-packer.
 *
 * Everything this plugin does — intercepting the paste, inserting the packing
 * chip, rendering the card above the composer and expanding the text again at
 * submit time — happens in the browser half (`./client`). The Host half stays
 * empty on purpose: no Host service, no Tool, no session event is involved, so
 * the plugin adds nothing to the session log and needs no Host dependencies.
 */
export function apply() {}
