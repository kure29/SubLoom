import { describe, expect, it } from 'vitest'
import { detectClient } from '../src/sub/user-agent.js'

// target=auto 时按 User-Agent 识别客户端。见 PLAN.md 5.3"User-Agent 识别"。
// UA 取自各客户端实际发出的请求（版本号可能不同）。
const cases: Array<[label: string, ua: string, client: string, target: string]> = [
  // Surge
  ['Surge iOS', 'Surge iOS/3083', 'surge', 'surge'],
  ['Surge Mac', 'Surge Mac/2735', 'surge', 'surge'],
  ['Surge（旧版 UA）', 'Surge/1938 CFNetwork/1335.0.3 Darwin/21.6.0', 'surge', 'surge'],
  ['大小写不同', 'SURGE IOS/3000', 'surge', 'surge'],
  // 导出器尚未实现：回退到 mihomo
  [
    'Shadowrocket',
    'Shadowrocket/2070 CFNetwork/1410.0.3 Darwin/22.6.0 iPhone14,5',
    'shadowrocket',
    'mihomo',
  ],
  ['Loon', 'Loon/797 CFNetwork/1410.0.3 Darwin/22.6.0', 'loon', 'mihomo'],
  // mihomo 系
  ['Stash', 'Stash/2.4.6 Clash/1.9.0', 'stash', 'mihomo'],
  ['Clash Verge Rev', 'clash-verge/v2.0.3', 'mihomo', 'mihomo'],
  [
    'ClashX Meta',
    'ClashX Meta/v1.4.1 (com.metacubex.ClashX.meta; build:1.4.1; macOS 14.5.0) Alamofire/5.9.1',
    'mihomo',
    'mihomo',
  ],
  ['FlClash', 'FlClash/v0.8.70 clash-verge Platform/android', 'mihomo', 'mihomo'],
  ['Mihomo Party', 'mihomo.party/v1.5.13 (clash.meta)', 'mihomo', 'mihomo'],
  ['Clash Nyanpasu', 'clash-nyanpasu/v1.6.1', 'mihomo', 'mihomo'],
  ['ClashMetaForAndroid', 'ClashMetaForAndroid/2.11.1.Meta', 'mihomo', 'mihomo'],
  ['Clash for Windows', 'ClashforWindows/0.20.39', 'mihomo', 'mihomo'],
  ['Clash for Android', 'ClashForAndroid/2.5.12', 'mihomo', 'mihomo'],
  ['mihomo 内核', 'mihomo/1.18.9', 'mihomo', 'mihomo'],
  ['clash.meta', 'clash.meta', 'mihomo', 'mihomo'],
  // 识别失败：默认 mihomo
  ['浏览器', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 'unknown', 'mihomo'],
  ['Quantumult X', 'Quantumult%20X/1.0.30 (iPhone14,5; iOS 17.5)', 'unknown', 'mihomo'],
  ['sing-box', 'SFI/1.9.0 (sing-box 1.9.0; iOS 17.5)', 'unknown', 'mihomo'],
  ['curl', 'curl/8.7.1', 'unknown', 'mihomo'],
  ['不是单词边界的 loon', 'Balloon/1.0', 'unknown', 'mihomo'],
  ['空 UA', '', 'unknown', 'mihomo'],
]

describe('detectClient', () => {
  it.each(cases)('%s', (_label, ua, client, target) => {
    expect(detectClient(ua)).toEqual({
      client,
      target,
      // 识别出了客户端、但它的导出器还没实现
      fallback: client === 'shadowrocket' || client === 'loon',
    })
  })

  it('没有 User-Agent 时默认 mihomo', () => {
    expect(detectClient(undefined)).toEqual({
      client: 'unknown',
      target: 'mihomo',
      fallback: false,
    })
  })
})
