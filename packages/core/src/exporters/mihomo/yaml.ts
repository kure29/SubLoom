import { Document, isScalar, visit } from 'yaml'

/**
 * mihomo 用 go-yaml v3 读取配置：除 YAML 1.2 core schema 外，它还会把 0777、0b101、1_000
 * 这类写法读成数字，旧版 YAML 1.1 还会把 yes/no/on/off 读成布尔值。
 * 这些字符串一律加引号，保证读到的仍是字符串。
 */
const AMBIGUOUS =
  /^(?:[-+]?[0-9][0-9_]*|[-+]?0[xX][0-9a-fA-F_]+|[-+]?0[oO][0-7_]+|[-+]?0[bB][01_]+|[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?[eE][-+]?[0-9]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~|<<|=)$/

export function stringifyYaml(value: unknown): string {
  const doc = new Document(value)
  visit(doc, {
    Scalar(_, node) {
      if (isScalar(node) && typeof node.value === 'string' && AMBIGUOUS.test(node.value)) {
        node.type = 'QUOTE_DOUBLE'
      }
    },
  })
  // 不折行
  return doc.toString({ lineWidth: 0 })
}
