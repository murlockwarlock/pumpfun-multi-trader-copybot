# Кандидаты для shadow-копирования на 0,005 SOL

**Решение — NO-GO на отбор нового адреса для копирования.** Для сбора данных оставлены три локальные shadow-подписки на один 48-часовой сеанс. `DGma4…` — кандидат на дальнейшую проверку, Kaaox — контроль, `sssssv2…` — проверка покрытия на активном потоке. Экономическая воспроизводимость остаётся **UNPROVEN**.

## Как собрана выборка

Начальная выборка взята из подтверждённых транзакций нескольких пулов, обнаруженных в журнале Kaaox. В каждом примере проверены успешный статус, фактическая подпись адреса, аутентифицированное событие Pump/PumpSwap и изменение принадлежащего подписанту токен-баланса в нужную сторону. Для PumpSwap mint восстановлен из противоположного движения base vault пула. Такой способ отбора смещён к нескольким активным рынкам, включая один пул с non-SOL. [Спецификация истории адреса](https://solana.com/docs/rpc/http/getsignaturesforaddress)

Первичный фильтр смотрит последние 72 часа, максимум 16 адресных сигнатур на кошелёк. При насыщении лимита это хвост истории, поэтому доля BUY/SELL и PnL не распространяются на все 72 часа. Старые остатки, частичные выходы, повторные входы и неполные тела вынесены из точного сопоставления закрытых позиций. Условный PnL оригинала использует суммы аутентифицированных SOL-сделок и сетевые комиссии, если их заплатил исследуемый адрес. Отдельные tips, rent и движения вне сопоставленных пар не включены. Длина удержания рассчитана по blockTime от сопоставленного BUY до первого SELL. Порог 10 с применяется к наблюдаемым удержаниям.

Балл первичного отбора складывается из 3 баллов за допустимый BUY и SELL, максимум 20 по каждой стороне, 5 баллов за удержание от 10 с, максимум 20, 20 баллов за достигнутую границу без недостающих тел и 10 баллов за положительный условный PnL. Это рейтинг для выделения RPC-бюджета. Короткие неполные окна и одна удачная сделка не подтверждают доходность.

### Первичный фильтр

Окно 08.11.2026, 11:42:43 – 11.11.2026, 11:42:43 по Кызылорде. Проверено 15 адресов. За проход 309 HTTP-запросов, включая 69 неудачных попыток. Для всех 15 достигнут лимит первой страницы раньше границы 72 ч. В evidence сохранены полные сигнатуры и raw-дельты.

| Адрес | Балл | BUY/SELL | Допустимые BUY/SELL | Неподдерж. или неатриб. / non-SOL | p10 удержания, с (n) | Тел/сигнатур | Условный PnL, SOL (циклы) | Проверяемая сделка |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT` | 60 | 7/8 | 7/8 | 0/0 | 13 (2) | 15/16 | 0.094693 (2) | [pumpswap SELL](https://explorer.solana.com/tx/cpo185SpZ2tKPMQsqzSRWJUcZrNpGaGKLwRMiSWT3u4i3JBrYUCfHhprCVi9u6EjSpGDhDSoP76qh9UiFKavVRC) |
| `DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm` | 49 | 3/8 | 3/7 | 1/0 | 374 (2) | 16/16 | 0.037869 (2) | [pumpswap SELL](https://explorer.solana.com/tx/28u3Sdbht5Ljb7DfiGpGQfKMrhYARrKe82HdDxHeD7Ydove6tx13d2nAaAPzCQJuWNFfBKBg4MUeKN3PyvNwH3st) |
| `ZPYAJfWjUJ5uEnmNq3QiejwVtuu7XAFxJbnpvqwNunT` | 46 | 2/7 | 2/7 | 0/0 | 39 (2) | 16/16 | 0.064233 (1) | [pumpswap SELL](https://explorer.solana.com/tx/4FM7eTwmVErtwhLXZUM8DgcQoSRYJZuKTPrpoZzbMVyyTH5NiMHMSb8nmV59cVAvi3WNWsRADEQWhdPtkcwKra86) |
| `nQEqsdvAymSR5mgG9NKbJL8HCkgRnxPLmrCN5q7awR2` | 39 | 3/8 | 3/8 | 0/0 | 38 (2) | 13/16 | -0.194925 (1) | [pumpswap BUY](https://explorer.solana.com/tx/2Q31nVcGK57Y4kUNatfKPmfR7uLTAu26Mhnz4KtWdT5TU6BHCJYvV4rF4QjU3Ns9v5e255Vy1kJdzGFbgmQgpuqx) |
| `96JTtvBj3PP2WTsXrCSaSH3Ga4aboutJX2s4ZHNjENcA` | 38 | 6/6 | 3/3 | 1/5 | 10 (2) | 16/16 | 0.282040 (2) | [pumpswap SELL](https://explorer.solana.com/tx/3FUHzeG3ZSojxmLWeBEW265EfHUJw8GW1STEb8HXvVi243TBr7caq2MYs8wrxoeuumgkpRiaqJV66FfDWwYQZsF3) |
| `5hqZDJQidTDmjCrLLYi1NiwNUuCZYFc4vo9bPPMr3w85` | 37 | 6/8 | 3/6 | 2/3 | 20 (2) | 13/16 | -0.136359 (2) | [pumpswap SELL](https://explorer.solana.com/tx/5VLE3GwoSm8qiPMXoQqqqKy5m4GaBegHMibU1USVEVSigYyj8vTEgHk1ti5siSd74XNNdE3RhzZsfjq9dCdyNgRN) |
| `7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5` | 34 | 6/8 | 3/5 | 3/3 | 51 (2) | 16/16 | -0.280098 (2) | [pumpswap SELL](https://explorer.solana.com/tx/4FC7r7z6wLAhLSzXcG7986N6moHMLbn26FkyHhBPwb8w2MXwLgEwLuojTTRZq7dCEZxgNsS21KAqQJLTng2T5W4d) |
| `J775kTzu4Rc4ypuE2EV6dW9uhXckFriPjSe6H5dm7ETo` | 23 | 13/1 | 10/1 | 0/3 | — (0) | 16/16 | UNKNOWN (0) | [pumpswap BUY](https://explorer.solana.com/tx/2zJgnY6Va6HnmCRcrUFtjrm9EnvbZRtP4DKsd79y9FpWff5YxpM7yBEY5Lr5tgCy8qynAxJckykiWbtZSveE3QDF) |
| `Dy3SzktmtXk4V4JmKFkPf2nSnkXTKKdKDS5wdWqV4DKU` | 22 | 13/2 | 2/2 | 0/11 | 213 (2) | 16/16 | -0.003555 (1) | [pumpswap SELL](https://explorer.solana.com/tx/5UZ9jrGyB3bdFPmgoZw3xAJw1BfU6tvNRh7fR7fUf79Wd27yy7iHsMPZfJj1P3TGDf6FBqJWhQooebPsHDNk2ojF) |
| `Dk9vfrCwmwECom1U32goPyJmFx3hnrnEW5j1VtaxvboR` | 18 | 7/6 | 1/5 | 0/7 | — (0) | 16/16 | UNKNOWN (0) | [pumpswap SELL](https://explorer.solana.com/tx/3iq8hjKWvjB4wzE13vWBbDWm68QT2K8vuMMUj5z5i3g5mRmTQkNSNtNhF8crBQD9B6xtJMEKZWQnheawNvFpBEAe) |
| `DZcyYa9aPRFnbkDPn3HYvfpiRH9GBz3EjTB5fLjk8Vge` | 15 | 8/5 | 2/3 | 1/7 | — (0) | 16/16 | UNKNOWN (0) | [pumpswap SELL](https://explorer.solana.com/tx/4Pu8Eqsc5XzTe6ovDF49gj11yxz3V1RJdtWSmHkyGjKPDzZtWsAfBYc2eyco7QEWbyZSuXtvsW4GeQTpKQsa7Z3S) |
| `93mHHYnW8JtSvxkj5nx6x3knNE9E6Qir9yQVPjXqBYU` | 12 | 4/8 | 0/4 | 0/8 | — (0) | 16/16 | UNKNOWN (0) | [pumpswap SELL](https://explorer.solana.com/tx/5zxYskwWCCQ9HvzTx45FoS1zfb4aNgcB3LABKuQzSHcz2mDrvs6M9AE9HbaN11RWY8zHkX8vMbWnpXEvC2W3DYDM) |
| `4ETcnpXZ613FqpoaN53n1wS1cMtJcVk7ZShEef6sQdGE` | 9 | 2/4 | 0/3 | 0/3 | — (0) | 16/16 | UNKNOWN (0) | [pumpswap SELL](https://explorer.solana.com/tx/tQ7gg1PxuGhtqBJLfVX77z9e58BoLc8sqeeVscLL4BSBstnqb1bDKuus9TAFoGox8i63ZG3gev2JCYNUQfbaxqV) |
| `BG6BS3Vz7KDg1rhF1QDpM1ZaFeZDhQm5BKMTSH3SD3zZ` | 6 | 4/5 | 0/2 | 0/7 | — (0) | 12/16 | UNKNOWN (0) | [pumpswap SELL](https://explorer.solana.com/tx/3s5hxbvmVLEqDhNDrbofEQdfxKq54vChujzbEJLck8apCZt4sjCEwbv9SP6epMiRyMHPS6oGTAcmLA5ciVQWPT6U) |
| `EziUk2qXXSWZiqRSKGYunY2sKmkdpwG86tdm2Q9TgKwF` | 0 | 5/2 | 0/0 | 0/7 | — (0) | 13/16 | UNKNOWN (0) | [pumpswap SELL](https://explorer.solana.com/tx/ceL3ipBBRoUWCo5ygY5txR9sbGw98HXG6jKVdkaSsTCPmq4L2DDxeKuP712TY9zbAquRQdvdHQSC6r4XRHT1qfH) |

### Семидневная проверка двух лидеров первичного фильтра

Окно 04.11.2026, 11:42:43 – 11.11.2026, 11:42:43 по Кызылорде. Адресный каталог выгружен постранично. При более чем 120 сигнатурах разобраны до восьми непрерывных участков по 15 тел, распределённых по каталогу. Себестоимость не переносится через пропущенные тела. Лимит 270 HTTP-запросов на этап. Фактически 222 запросов, 2 неудачных попыток.

| Адрес | Каталог / выборка / получено | Граница 7 дней | BUY/SELL → допустимые | Неатриб. / non-SOL | p10/p50 удержания, с (n) | Условный PnL SOL (W/L, SELL без basis) |
|---|---:|---|---:|---:|---:|---:|
| `DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm` | 337/120/119 | достигнута | 44/42 → 34/27 | 2/23 | 6/180 (7) | 1.143735 (6/1, 20) |
| `sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT` | 7939/120/112 | не достигнута | 70/39 → 70/39 | 0/0 | 0/4 (10) | -0.117007 (7/3, 29) |

- `DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm`. SOL-резерв в примерах 5.209–31.194 SOL. Это снимки источника, доступность цены копии измеряется отдельно. [pump-curve BUY](https://explorer.solana.com/tx/2MgRTCoaiv8mpQZBguJodwQhYFq4z9a3pnLGRptv83zeN8GNFsGhrYty36vZWxHeGMmwBTGa5g9ANG85TKPxshNY) · [pump-curve BUY](https://explorer.solana.com/tx/3QxKcpei3dZG5eCKZsv33rgyfCgeYXLfZPFAWneCnUHnnfMASZ1bfBx4vS3XhC1HsN1NVU4vpK5akCh1kG7YptRi) · [pumpswap SELL](https://explorer.solana.com/tx/56GwBAijq9XvMz6uEDkS4ygASbjCJGwaEZiCi4SijeZAwbkD48Tcq8D9TbVhNw75HVnksp87AbLgvT1UXRbsWeud) · [pump-curve SELL](https://explorer.solana.com/tx/4F6dqpuYgKwiLu1AQ9VK9i9uhLLRQeR8jbaC8wziCjd2FWHi4ZmaQNH4wv3tduih21hYwmxwodRE9wDVNKptsa5Z)
- `sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT`. SOL-резерв в примерах 13.899–199.731 SOL. Это снимки источника, доступность цены копии измеряется отдельно. [pumpswap BUY](https://explorer.solana.com/tx/3wM86NgETyvLsbJQbZQcSFeh5m8tCi7DTKhnakq7nXejqqjqa1w2VqZHQdJFuQGQUoaY9zwkKpfUJUSJT18y5fhV) · [pumpswap BUY](https://explorer.solana.com/tx/5K1CBJHi6MdsEnbeeDDMgv2SjgGbWmXnGw24GoXnVC3jd8atmb9wCxZLqT1QUVQ1fy8NUAbmHofJJZmFaD4CwKqd) · [pumpswap SELL](https://explorer.solana.com/tx/UNAUfreRHAUz2Hu6SvtpnkSiJsEstMLa5xW5htewB9yMRcCxkLJCfiudLfAn3WYCNERqTvu6g2ysAPSbXK7qNoD) · [pumpswap SELL](https://explorer.solana.com/tx/4Z9Xo5edw1C1a8vwcdCWpSxLKpUefEP2izRchMAVACo2v2oiymcUaAdDuqyh6pxwd3jqn6iKFyZ6p16qHLBFq5Tr)

Предварительный список ограничен этими двумя адресами. У `DGma4…` медиана удержания 180 с, однако p10 равен 6 с, а для 20 из 27 технически допустимых SELL себестоимость неизвестна. Это приоритет для проверки котировками. У `sssssv2…` p10 равен нулю по округлённому blockTime, а медиана — 4 с. Даже после просмотра 7 939 сигнатур каталог этого адреса дошёл только до утра 10 ноября. Этот адрес не проходит фильтр удержания для дальнейшего отбора. Остальные адреса не подключены к наблюдателю.

## Независимые BUY и SELL

Отдельный Node-процесс подписан на логи адресов с commitment `confirmed`. Сигнал сверяется с телом той же сигнатуры и слота, подписантом и фактическим изменением баланса. После проверки обычного SOL BUY наблюдатель запрашивает SDK-котировку за **5 000 000 lamports** с `minContextSlot` исходного сигнала. Он записывает ожидаемый raw output, моделируемое количество по нижней границе 100 bps и исходному ограничению цены, minOut, слот, commitment, задержку, RPC-расход, торговые комиссии SDK и оценку rent. Точное разложение BUY комиссии кривой SDK не возвращает.

SELL-котировка заново считывает текущие аккаунты и оценивает то же raw количество. Независимые сценарии фиксированы на **10, 30, 120 с** от прихода BUY и на первом проверенном SELL таргета в пределах 900 с. Основной горизонт для сравнения — 30 с. Для target-выхода требуется непрерывная WS-подписка между сигналами. Выходы на площадках без распознаваемого события могут быть пропущены. Неизвестный или поздний результат получает `UNKNOWN`. После 2 500 мс с момента уведомления или срока фиксированного выхода цена уже не входит в соответствующий сценарий. Commitment confirmed выбран для проверяемых котировок, поэтому задержка считается от прихода confirmed-уведомления. BlockTime округлён и может расходиться с часами наблюдателя.

Оригинальные сигнатуры BUY и SELL должны позже финализироваться в тех же слотах. Снимки рынка остаются confirmed, поэтому финальность источника не гарантирует финальность каждого RPC-снимка и включение гипотетической сделки. Суммы SDK учитывают торговые комиссии. Выход дополнительно уменьшается на 100 bps, из результата вычитаются вход 0,005 SOL и по 0,00011 SOL на BUY, SELL и CLOSE. В сетевой оценке 5 000 base, 100 000 priority и 5 000 tip lamports на действие. Это допущения модели. Невозврат rent показан отдельным сценарием. Котировка не доказывает исполнение, а проскальзывание выше minOut, неуспешный выход или потеря ликвидности могут увеличить убыток. [Формат подписки Solana](https://solana.com/docs/rpc/websocket/logssubscribe)

### Первый prospective срез

Подписки приняты с 11.11.2026, 11:47:00 по Кызылорде. Снимок сформирован 11.11.2026, 11:53:20. Сигналы SOURCE UNKNOWN показаны отдельно от подтверждённого знаменателя. UNKNOWN для горизонта включает незавершённые таймеры и неподтверждённую финальность на момент снимка.

| Адрес | Сигналы | Допуст. BUY/SELL | Своевр. BUY | Пары / UNKNOWN 30 с | Net 30 с, SOL | Без лучшей | SOURCE UNKNOWN |
|---|---:|---:|---:|---:|---:|---:|---:|
| `3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG` | 0 | 0/0 | 0/0 (—) | 0 / 0 | UNKNOWN | UNKNOWN | 0 |
| `sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT` | 39 | 21/12 | 8/21 (38.1%) | 3 / 18 | -0.003394492 | -0.002968024 | 6 |
| `DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm` | 0 | 0/0 | 0/0 (—) | 0 / 0 | UNKNOWN | UNKNOWN | 0 |

| Адрес | Триггер | Котировки / пары с finalized источником | UNKNOWN | Net, SOL | Без лучшей |
|---|---|---:|---:|---:|---:|
| `3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG` | 10s | 0/0 | 0 | UNKNOWN | UNKNOWN |
| `3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG` | 30s | 0/0 | 0 | UNKNOWN | UNKNOWN |
| `3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG` | 120s | 0/0 | 0 | UNKNOWN | UNKNOWN |
| `3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG` | target | 0/0 | 0 | UNKNOWN | UNKNOWN |
| `sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT` | 10s | 5/5 | 16 | -0.002668301 | -0.002219529 |
| `sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT` | 30s | 3/3 | 18 | -0.003394492 | -0.002968024 |
| `sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT` | target | 1/1 | 20 | -0.001989832 | UNKNOWN |
| `sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT` | 120s | 3/3 | 18 | -0.001638671 | -0.001308955 |
| `DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm` | 10s | 0/0 | 0 | UNKNOWN | UNKNOWN |
| `DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm` | 30s | 0/0 | 0 | UNKNOWN | UNKNOWN |
| `DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm` | 120s | 0/0 | 0 | UNKNOWN | UNKNOWN |
| `DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm` | target | 0/0 | 0 | UNKNOWN | UNKNOWN |

Первая фактическая пара использовала 722280061 raw единиц. BUY через 2375 мс, confirmed slot 468028422, SELL 10s через 1506 мс от таймера, confirmed slot 468028468. SELL minOut 4881228 lamports, модельный net -0.000448772 SOL. Если rent не возвращён, этот сценарий даёт -0.001962612 SOL. [Сигнал BUY](https://explorer.solana.com/tx/3BYZtzFsky8PQBoWtNTtYCDFwzhxuQfVi5f6eSVv3ynXCbYfgDRTDRBkAbFC9n12yJv1o5Yt9bphGNu9wqi7jE8F)

Короткий срез пока не позволяет ранжировать по прибыли. RPC 429, ограничения бюджета, отсутствие наблюдённого SELL и таймеры, ещё открытые к моменту снимка, уменьшают покрытие. Контрольные котировки по более ранним транзакциям сохранены как диагностика и исключены из prospective таблиц.

## Запуск и проверка

```powershell
New-Item -ItemType Directory -Force work/next-copy
node scripts/next-copy-observer.mjs work/next-copy/session.jsonl 3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm
node scripts/next-copy-summary.mjs work/next-copy/session.jsonl
```

Наблюдатель завершает локальный сеанс через 48 часов. Повторный старт начинает отдельный run, незавершённые выходы остаются UNKNOWN. Отдельный процесс не подключён к FAST execution path, использует только публичный ключ-заглушку и read-only RPC. У него лимит 45 аккаунтных и 18 проверочных запросов в минуту, лимит коротких всплесков и пауза при 429. На развёрнутом сервисе проверены `STOP_LIVE` и `LIVE_TRADER_WALLETS=none`. Журнал исследования ведётся локально.

[Машиночитаемые результаты, адреса, сигнатуры и котировки](evidence/next-copy-candidates.json).
