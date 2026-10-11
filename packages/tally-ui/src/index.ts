/**
 * Host half of dsh-tally-ui. It only names the Loader entry: everything the plugin does happens
 * in the browser bundle (`dsh-tally-ui/client`), which talks to `dsh-tally` through the `tally`
 * Remote namespace.
 */
export const name = 'dsh-tally-ui'

export function apply(): void {}
