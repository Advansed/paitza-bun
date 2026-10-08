-- Кошелёк переезжает с пользователя на организацию.
-- t_kassa.user и t_kassa_lefts.user начинают хранить t_company.id.
-- Если у пользователя несколько организаций, берётся запись с минимальным id.
-- Повторный запуск ничего не меняет: после первого прохода user уже не равен client.

UPDATE t_kassa k
INNER JOIN (
  SELECT client, MIN(id) AS id
  FROM t_company
  GROUP BY client
) c ON c.client = k.`user`
SET k.`user` = c.id
WHERE k.`user` <> c.id;

UPDATE t_kassa_lefts l
INNER JOIN (
  SELECT client, MIN(id) AS id
  FROM t_company
  GROUP BY client
) c ON c.client = l.`user`
SET l.`user` = c.id
WHERE l.`user` <> c.id;
