import { describe, expect, it } from 'vitest'
import upstreamHeaders from '../../core/test/fixtures/import/subscription-headers.json' with {
  type: 'json',
}
import { formatUserinfo, mergeUserinfo, parseUserinfo } from '../src/userinfo.js'

describe('parseUserinfo', () => {
  it('解析 fixtures 中的上游响应头', () => {
    expect(parseUserinfo(upstreamHeaders['subscription-userinfo'])).toEqual({
      upload: 1073741824,
      download: 10737418240,
      total: 107374182400,
      expire: 1798732800,
    })
  })

  it('容忍空白、大小写、字段顺序和多余的分号', () => {
    expect(parseUserinfo(' Total = 100 ;upload=1;; download=2 ; ')).toEqual({
      upload: 1,
      download: 2,
      total: 100,
    })
  })

  it('缺失、空值、非数字、负数的字段省略，未知字段忽略', () => {
    expect(parseUserinfo('upload=1; download=; total=abc; expire=-5; foo=3')).toEqual({ upload: 1 })
    expect(parseUserinfo('upload=1.5e3; download=12abc')).toBeNull()
  })

  it('expire=0 保留（部分机场用 0 表示不过期）', () => {
    expect(parseUserinfo('upload=0; download=0; total=0; expire=0')).toEqual({
      upload: 0,
      download: 0,
      total: 0,
      expire: 0,
    })
  })

  it('没有任何可用字段或没有该头时为 null', () => {
    expect(parseUserinfo(null)).toBeNull()
    expect(parseUserinfo('')).toBeNull()
    expect(parseUserinfo('garbage')).toBeNull()
  })
})

describe('mergeUserinfo', () => {
  const a = { upload: 1, download: 10, total: 100, expire: 1_800_000_000 }
  const b = { upload: 2, download: 20, total: 200, expire: 1_700_000_000 }

  it('upload、download、total 求和，expire 取最早', () => {
    expect(mergeUserinfo([a, b])).toEqual({
      upload: 3,
      download: 30,
      total: 300,
      expire: 1_700_000_000,
    })
  })

  it('只有一个来源时原样返回', () => {
    expect(mergeUserinfo([a])).toEqual(a)
  })

  it('缺少该头的来源（null）不参与合并', () => {
    expect(mergeUserinfo([null, a, null, b])).toEqual(mergeUserinfo([a, b]))
    expect(mergeUserinfo([a, null])).toEqual(a)
  })

  it('所有来源都缺少该头、或没有来源时为 null', () => {
    expect(mergeUserinfo([null, null])).toBeNull()
    expect(mergeUserinfo([])).toBeNull()
  })

  it('某个字段只对给出了它的来源求和；没有来源给出的字段省略', () => {
    expect(
      mergeUserinfo([
        { upload: 5, total: 100 },
        { download: 7, total: 50 },
      ]),
    ).toEqual({
      upload: 5,
      download: 7,
      total: 150,
    })
    expect(mergeUserinfo([{ upload: 1 }, { upload: 2 }])).toEqual({ upload: 3 })
  })

  it('expire 只在给出了它的来源中取最早；expire=0（不过期）视为未给出', () => {
    expect(mergeUserinfo([{ total: 1 }, { total: 1, expire: 1_800_000_000 }])).toEqual({
      total: 2,
      expire: 1_800_000_000,
    })
    expect(
      mergeUserinfo([
        { total: 1, expire: 0 },
        { total: 1, expire: 1_800_000_000 },
      ]),
    ).toEqual({
      total: 2,
      expire: 1_800_000_000,
    })
    expect(
      mergeUserinfo([
        { total: 1, expire: 0 },
        { total: 1, expire: 0 },
      ]),
    ).toEqual({ total: 2 })
  })
})

describe('formatUserinfo', () => {
  it('按 upload、download、total、expire 的顺序输出，省略缺失的字段', () => {
    expect(formatUserinfo({ expire: 4, total: 3, download: 2, upload: 1 })).toBe(
      'upload=1; download=2; total=3; expire=4',
    )
    expect(formatUserinfo({ total: 3 })).toBe('total=3')
  })

  it('与 parseUserinfo 往返一致', () => {
    const header = upstreamHeaders['subscription-userinfo']
    const parsed = parseUserinfo(header)
    expect(parsed && formatUserinfo(parsed)).toBe(header)
  })
})
