# 第五期 Mac 公测记录

正式签名包通过干净设备的安装和升级验证后，邀请 10 位参与者使用自己的项目。首次交付以本人完成并打开导出的作品为准。只要主持人代为操作或指导了必需步骤，就选「有协助」。第二次使用须是参与者主动使用另一个真实项目。请在取得参与者同意后记录观察结果。

## 建立本机记录

在仓库内运行 `npm run beta:report -- --init`，再编辑生成的 `artifacts/phase-five/beta.json`。每位实际参与者在 `participants` 数组中占一项。仓库已忽略记录目录。以下内容是填写示例。

```json
{
  "participants": [
    {
      "id": "P01",
      "startedAt": "2026-11-26T10:00:00+08:00",
      "firstDelivery": "pending",
      "secondProjectAt": null,
      "followUp": "open"
    }
  ]
}
```

| 字段 | 填写方式 |
| --- | --- |
| id | 使用匿名编号，如 P01。每人一行。 |
| startedAt | 实际开始试用的时间，含时区。 |
| firstDelivery | 选 `independent` 独立、`assisted` 有协助、`failed` 失败、`withdrew` 退出或 `pending` 尚待记录。 |
| secondProjectAt | 经确认主动使用第二个项目时填入实际时间。尚无记录时保留 `null`。 |
| followUp | 观察中填 `open`，已核对填 `confirmed`，七天期满且失联填 `lost`。 |

## 读取结果

运行 `npm run beta:report`。首次独立交付和七天内复用均以实际入组人数作分母。退出和失访者保留在分母内。第二个项目在入组后 168 小时内开始使用即计入复用。观察期尚未满七天的人数另外列出，便于判断当前数据是否足以复盘。未建记录和空白记录都有单独提示。

满 10 人且都走完观察期后，用真实计数对照路线图中的建议目标，首次独立交付 8 人，一周内主动复用 5 人。真实设备、安装升级结果和故障复现记录需另行核对。[第五期验收标准](innovation-roadmap.md#第五期--在真实-mac-和真实工作中验证专业版)
