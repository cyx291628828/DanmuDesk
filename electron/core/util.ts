import type { DyLiveInfo } from './dycast';

/**
 * 解析直播间信息（旧版：整段 JSON 反序列化）
 *  - 依赖页面内嵌的 __pace_f 脚本做反序列化，新版页面结构变化后正则不再匹配，
 *    已由 parseLiveHtml（字段级正则）替代，保留仅作参考
 * @param html 直播间页面 HTML
 * @returns 解析失败返回 null
 */
export const parseLiveHtml_old = function (html: string): DyLiveInfo | null {
  try {
    // 抓取内嵌的 __pace_f.push 脚本参数（含整个页面 state JSON）
    const matchRes = html.match(
      /<script\snonce="\S+?"\s>self\.__pace_f\.push\(\[1,"[a-z]?:\[\\"\$\\",\\"\$L\d+\\",null,([\s\S]+?state[\s\S]+?)\]\\n"\]\)<\/script>/
    );
    // 反序列化前需要逐级修复被转义的引号/括号
    const REGLIST = [
      {
        reg: /\\{1,7}"/g,
        str: '"'
      },
      {
        reg: /"\{/g,
        str: '{'
      },
      {
        reg: /\}"/g,
        str: '}'
      },
      {
        reg: /"\[(.*)]\"/g,
        str: '[$1]'
      },
      {
        reg: /([^:,{\[])(")([^:,}\]])/g,
        str: '$1"$3'
      }
    ];
    if (!matchRes) return null;
    let json: string = matchRes[1];
    for (const REG of REGLIST) {
      json = json.replace(REG.reg, REG.str);
    }
    const data = JSON.parse(json);
    return {
      roomId: data['state']['roomStore']['roomInfo']['roomId'],
      uniqueId: data['state']['userStore']['odin']['user_unique_id'],
      avatar: data['state']['roomStore']['roomInfo']['anchor']?.['avatar_thumb']?.['url_list'][0],
      cover: data['state']['roomStore']['roomInfo']['room']?.['cover']?.['url_list'][0],
      nickname: data['state']['roomStore']['roomInfo']['anchor']['nickname'],
      title: data['state']['roomStore']['roomInfo']['room']['title'],
      status: data['state']['roomStore']['roomInfo']['room']['status']
    };
  } catch (err) {
    return null;
  }
};

/**
 * 解析直播间信息（当前版本：字段级正则，对页面结构变化更鲁棒）
 *  - 从 __pace_f.push 内嵌 state 中按字段正则逐一提取，避免整段 JSON
 *    反序列化因某字段转义不匹配而整体失败
 *  - roomId 是 19 位内部 ID（WSS/im/fetch 必需），status 2=直播中
 * @param html 直播间页面 HTML
 * @returns 解析失败返回 null
 */
export const parseLiveHtml = function (html: string): DyLiveInfo | null {
  try {
    const matchRes = html.match(
      /<script\snonce="\S+?"\s>self\.__pace_f\.push\(\[1,"[a-z]?:\[\\"\$\\",\\"\$L\d+\\",null,([\s\S]+?state[\s\S]+?)\]\\n"\]\)<\/script>/
    );
    if (!matchRes) return null;
    let json: string = matchRes[1];
    // 各字段的正则：按 state → roomStore → roomInfo → 具体字段 逐层定位
    const REGMAP: Record<string, RegExp> = {
      roomId: /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"roomId":"([0-9]+?)"/,
      uniqueId: /{"state":{[\s\S]*?"userStore":{[\s\S]*?"odin":{[\s\S]*?"user_unique_id":"([0-9]+?)"/,
      avatar:
        /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"anchor":{[\s\S]*?"avatar_thumb":{[\s\S]*?"url_list":\["([\S]+?)"/,
      cover:
        /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"room":{[\s\S]*?"cover":{[\s\S]*?"url_list":\["([\S]+?)"/,
      nickname: /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"anchor":{[\s\S]*?"nickname":"([\s\S]+?)"/,
      title: /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"room":{[\s\S]*?"title":"([\s\S]+?)"/,
      status: /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"room":{[\s\S]*?"status":([0-9]{1})/,
      // 主播粉丝数/关注数（anchor 区域内的 follow_info；roomInfo 为空时匹配不到，返回空由上层兜底）
      anchorFollower:
        /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"anchor":{[\s\S]*?"follow_info":{[\s\S]*?"follower_count":(\d+)/,
      anchorFollowing:
        /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"anchor":{[\s\S]*?"follow_info":{[\s\S]*?"following_count":(\d+)/,
      // 本场直播总点赞数：真实值在 "like_count":N,"owner_user_id_str" 处（webcast room 数据块）。
      // 注意 room.stats 里的 like_count 恒为 0 占位值，勿用（实测两个直播间均为 0）；
      // 页面拿不到时返回空，由弹幕点赞消息（total 字段）兜底实时更新
      likeCount: /"like_count":(\d+),"owner_user_id_str"/,
      // 主播数字 uid / sec_uid（anchor 对象开头，用于 user/profile 接口查粉丝/关注数）
      anchorId: /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"anchor":\{"id_str":"(\d+)"/,
      anchorSecUid: /{"state":{[\s\S]*?"roomStore":{[\s\S]*?"roomInfo":{[\s\S]*?"anchor":\{"id_str":"\d+","sec_uid":"([A-Za-z0-9_-]+)"/
    };
    function extractJsonField(name: string, json: string) {
      const reg = REGMAP[name];
      let res: string = '';
      if (reg) {
        const exec = reg.exec(json);
        if (exec) res = exec[1];
      }
      return res;
    }
    // URL 里的 \u0026 是 & 的转义，恢复后才是真实图片地址
    function decodeUnicodeUrl(url: string) {
      if (url) return url.replace(/\\u0026/g, '&');
      else return url;
    }
    json = json.replace(/\\{1,7}"/g, '"');
    const roomId = extractJsonField('roomId', json);
    const uniqueId = extractJsonField('uniqueId', json);
    const avatar = extractJsonField('avatar', json);
    const cover = extractJsonField('cover', json);
    const nickname = extractJsonField('nickname', json);
    const title = extractJsonField('title', json);
    const status = extractJsonField('status', json);
    const anchorFollower = extractJsonField('anchorFollower', json);
    const anchorFollowing = extractJsonField('anchorFollowing', json);
    const likeCount = extractJsonField('likeCount', json);
    const anchorId = extractJsonField('anchorId', json);
    const anchorSecUid = extractJsonField('anchorSecUid', json);
    return {
      roomId,
      uniqueId,
      avatar: decodeUnicodeUrl(avatar),
      cover: decodeUnicodeUrl(cover),
      nickname,
      title,
      status: parseInt(status || '4'),
      followerCount: anchorFollower ? parseInt(anchorFollower) : undefined,
      followingCount: anchorFollowing ? parseInt(anchorFollowing) : undefined,
      likeCount: likeCount ? parseInt(likeCount) : undefined,
      anchorId: anchorId || undefined,
      anchorSecUid: anchorSecUid || undefined
    };
  } catch (err) {
    return null;
  }
};

/**
 * 将对象化成请求参数字符串
 *  - 如：item1=value1&item2=value2&...
 *  - 与 wss_hybrid_test.js 一致：值必须 encodeURIComponent（browser_version 含空格/括号，
 *    a_bogus 基于编码后的参数字符串计算，不编码会校验失败返回空 body）
 * @param params 请求参数对象
 * @returns
 */
export const makeUrlParams = function (params: any): string {
  return Object.keys(params)
    .map((n) => `${n}=${encodeURIComponent(params[n] ?? '')}`)
    .join('&');
};
