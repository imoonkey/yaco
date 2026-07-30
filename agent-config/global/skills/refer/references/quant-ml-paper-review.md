# ML Quant Paper Review Template

`type: paper` 且属于 quant / trading-ML 方向的论文做深度 review 时的 body template；
**其他领域的论文不适用**（维度是按交易系统 pipeline 设计的）。用法：

- **Checklist，不是槽位**：某个 section 真没内容就整节跳过，**保留编号**（允许跳号），不写 N/A 凑数。
- **论文没写 ≠ 没内容**：隐含假设也是内容。典型如 §8——多数学术论文不讨论执行，但"月末收盘出信号、同一收盘价零摩擦成交"这类隐含口径必须写出来：「论文未讨论，隐含口径是 X，偏乐观的方向在 Y」。
- 写到的数字必须带 table / section / equation 出处。
- 深度 review 是显式决定，不是默认动作——只归档不 review 时照常留空 body。

写出来的 `wiki/source/<id>.md` 形如：

```markdown
---
description: 一行 —— 这是什么、为什么值得记
tags: [paper, <topical>, ...]
---

# <Paper Title> — <Authors> (<Venue Year>)

## One-Paragraph Summary

<概括 + 可信度判断，放正文最前面，见下>

## 1. ...
```

（frontmatter 里机器字段由 fetcher 维护，人只写 `description` 和 `tags`。）

---

## One-Paragraph Summary

用一段话概括整篇论文：它在哪个市场、使用什么数据和模型、预测什么目标、如何转化为交易、取得什么 out-of-sample 结果，以及你对其可信度和实际价值的总体判断。放正文最前面——读者先扫这段再决定读不读细节。

## 1. Paper Overview and Research Question

简要记录论文的基本信息，包括标题、作者、年份、发表渠道和代码或数据链接（代码、数据、Internet Appendix 等 artifacts 各一个 bullet）。用一两句话概括论文试图解决的核心问题、主要贡献，以及作者认为预测能力或投资收益来源于什么经济机制或统计规律。同时说明 ML 在论文中扮演的角色，例如处理非线性、高维特征、时序结构、资产之间的关系，或直接优化投资组合。

## 2. Market and Trading Universe

描述策略交易的资产类别和具体可投资范围，包括股票、期权、期货、商品、外汇或加密资产，以及对应的市场、交易所和地区。说明 universe 如何构建和随时间更新，例如流动性、市值、价格、上市时间或数据完整性筛选，以及是否允许做空。这里也应记录对退市资产、历史指数成分、微盘股和生存者偏差的处理。

## 3. Data, Features, and Information Availability

说明论文使用的原始数据，包括价格、成交量、订单簿、基本面、宏观数据、新闻、文本、分析师预测、卫星或其他另类数据。进一步描述从原始数据中构造了哪些特征，以及特征经过了怎样的标准化、排序、去极值、中性化、缺失值处理或降维。特别记录数据在现实中何时可获得，是否使用 point-in-time 数据，是否考虑财报披露延迟、数据修订和其他潜在的信息泄露。

## 4. Prediction and Trading Setup

定义论文研究的预测问题，包括是横截面预测还是时间序列预测，预测对象是收益、方向、排名、波动率、风险、成交概率或其他目标。说明数据频率、生成预测的时间点、预测 horizon、预期持有周期和换仓频率。这一部分应明确模型究竟在什么时刻，使用什么信息，预测哪个未来区间的结果。

## 5. Model and Training Objective

描述模型类别、模型输入、核心架构和不同模型之间的组合方式，包括线性模型、树模型、神经网络、序列模型、图模型、强化学习或其他方法。记录训练 label、损失函数或优化目标，以及模型最终输出的形式，例如预期收益、收益排名、上涨概率、目标持仓或交易动作。若模型包含正则化、多任务学习、预训练、在线学习或 ensemble，也在这里说明。benchmark 类论文的模型对比矩阵直接写在这里，不需要变体模板。

## 6. Training and Evaluation Protocol

描述样本时间范围以及 train、validation 和 test 的划分方式，包括 expanding window、rolling window、固定时间划分或跨市场验证。说明模型多久重新训练、如何选择超参数、如何 early stop，以及是否处理 overlapping labels、时间边界泄露和随机种子敏感性。列出论文使用的基准模型和简单策略，以判断结果究竟来自新数据、模型复杂度还是实验设计。对多模型对比，明确协议是否公平：各模型的调参预算是否对等、几个 seed、split 是否完全一致。

## 7. From Model Output to Portfolio

说明模型输出如何转化为实际持仓，包括排序分组、top-k、long-only、long-short、阈值交易、position sizing 或 portfolio optimization。记录组合是否进行行业、市值、市场 beta、风险因子、净敞口、杠杆或单一资产权重限制，以及是否使用波动率目标。还应说明换仓频率、信号平滑、持仓缓冲区、turnover penalty 或其他减少无效交易的机制。

## 8. Order Generation and Execution Assumptions

说明目标持仓如何转化为订单，以及论文假设在什么价格和时间成交，例如收盘价、次日开盘价、VWAP、TWAP、market order 或 limit order。记录是否考虑执行延迟、部分成交、bid-ask spread、slippage、market impact、成交量限制和交易时段。对于做空、期权、期货或加密资产，还应包括借券、保证金、展期、资金费率和交易所差异等特有约束。论文完全不讨论执行时，本节退化为一两句隐含口径的判断，而不是删除。

## 9. Backtest Realism and Robustness

总结回测中考虑的交易成本、市场冲击、容量、流动性和可扩展性，并判断这些假设是否现实。检查是否存在 look-ahead bias、survivorship bias、selection bias、data snooping、multiple testing 或其他泄露问题。记录论文进行的 robustness checks 和 ablation studies，例如更换 universe、时间区间、成本假设、预测 horizon、模型、特征组、换仓频率或执行延迟后的表现。

## 10. Results and Performance Attribution

记录论文报告的主要预测指标和投资指标，例如 out-of-sample (R^2)、IC、Rank IC、accuracy、收益率、Sharpe ratio、最大回撤、turnover、alpha 和 t-statistic。明确结果是 gross 还是 net of costs，并总结不同子样本、市场状态和资产组中的稳定性。进一步分析收益是否可以被市场、行业或已知风格因子解释，以及改进主要来自模型、数据、portfolio construction 还是交易机制。

## 11. Interpretation, Limitations, and Personal Assessment

总结论文从模型或实证结果中得到的主要经济和投资洞见，例如重要特征、非线性关系、特征交互、市场状态变化或 signal decay。记录作者承认的局限，以及你认为最关键但作者没有充分解决的问题。最后给出自己的判断：论文最可信的贡献是什么、最脆弱的假设是什么、实际实现的主要障碍是什么、结果能否复现，以及它更适合作为学术研究、alpha research idea，还是接近可部署的交易策略。
