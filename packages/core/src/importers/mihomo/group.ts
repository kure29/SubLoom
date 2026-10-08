import {
  BuiltinTargetSchema,
  type GroupMember,
  type ProxyGroup,
  ProxyGroupSchema,
  ProxyGroupTypeSchema,
} from '../../ir/index.js'
import type { ImportWarning } from '../types.js'
import { canonical, describeIssues, extraOf, ImportError, isRecord, Reader } from '../util.js'

function convertGroup(
  src: unknown,
  path: string,
  names: { proxies: ReadonlySet<string>; groups: ReadonlySet<string> },
  warnings: ImportWarning[],
): ProxyGroup {
  if (!isRecord(src)) throw new ImportError('INVALID_GROUP', 'group must be a mapping')
  const r = new Reader(src)
  const name = r.str('name')
  if (!name) throw new ImportError('INVALID_GROUP', '"name" is required')
  const typeRaw = r.str('type')
  if (typeRaw === undefined) throw new ImportError('INVALID_GROUP', '"type" is required')
  const type = ProxyGroupTypeSchema.safeParse(typeRaw)
  if (!type.success) {
    throw new ImportError('UNSUPPORTED_GROUP_TYPE', `group type "${typeRaw}" is not supported`)
  }

  const members: GroupMember[] = []
  const list = r.raw('proxies')
  if (list !== undefined && !Array.isArray(list))
    throw new ImportError('INVALID_GROUP', '"proxies" must be a list')
  for (const [j, m] of (list ?? []).entries()) {
    const memberName = String(m)
    const builtin = BuiltinTargetSchema.safeParse(memberName)
    if (builtin.success) members.push({ kind: 'builtin', name: builtin.data })
    else if (names.groups.has(memberName)) members.push({ kind: 'group', name: memberName })
    else {
      // 找不到的名称按节点处理（订阅中的节点会变化），提示一下
      if (!names.proxies.has(memberName)) {
        warnings.push({
          level: 'info',
          code: 'UNKNOWN_GROUP_MEMBER',
          path: `${path}.proxies[${j}]`,
          message: 'member is neither a proxy, a group nor a built-in target',
        })
      }
      members.push({ kind: 'proxy', name: memberName })
    }
  }

  const include = r.str('filter')
  const exclude = r.str('exclude-filter')
  const group = {
    name,
    type: type.data,
    members,
    includeAllProxies: r.bool('include-all-proxies'),
    filter: include === undefined && exclude === undefined ? undefined : { include, exclude },
    testUrl: r.str('url'),
    interval: r.int('interval'),
    tolerance: r.int('tolerance'),
    hidden: r.bool('hidden'),
    icon: r.str('icon'),
    extra: extraOf('mihomo', r.rest()),
  }
  const parsed = ProxyGroupSchema.safeParse(canonical(group))
  if (!parsed.success) throw new ImportError('INVALID_GROUP', describeIssues(parsed.error))
  return parsed.data
}

export function convertGroups(
  src: unknown,
  proxyNames: ReadonlySet<string>,
  warnings: ImportWarning[],
): ProxyGroup[] {
  if (src === undefined || src === null) return []
  if (!Array.isArray(src)) {
    warnings.push({
      level: 'warn',
      code: 'INVALID_GROUP',
      path: 'proxy-groups',
      message: '"proxy-groups" must be a list',
    })
    return []
  }
  // 先收集可导入的组名，用于区分成员是组还是节点
  const groupNames = new Set<string>()
  for (const g of src) {
    if (
      isRecord(g) &&
      typeof g.name === 'string' &&
      ProxyGroupTypeSchema.safeParse(g.type).success
    ) {
      groupNames.add(g.name)
    }
  }
  const groups: ProxyGroup[] = []
  src.forEach((g, i) => {
    const path = `proxy-groups[${i}]`
    try {
      groups.push(convertGroup(g, path, { proxies: proxyNames, groups: groupNames }, warnings))
    } catch (e) {
      if (!(e instanceof ImportError)) throw e
      const code = e.code === 'INVALID_PROXY' ? 'INVALID_GROUP' : e.code
      warnings.push({ level: 'warn', code, path, message: e.message })
    }
  })
  return groups
}
