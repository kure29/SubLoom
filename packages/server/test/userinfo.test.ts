import { describe, expect, it } from 'vitest'
import upstreamHeaders from '../../core/test/fixtures/import/subscription-headers.json' with {
  type: 'json',
}
import { parseUserinfo } from '../src/userinfo.js'

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
