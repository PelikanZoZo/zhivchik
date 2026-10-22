-- Сервер создаёт эти таблицы сам при первом запуске.
-- Файл нужен, если хочешь создать их вручную через phpMyAdmin.

CREATE TABLE IF NOT EXISTS world_state (
  id TINYINT PRIMARY KEY,
  saved_at BIGINT NOT NULL,
  data LONGTEXT NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS lives (
  id INT AUTO_INCREMENT PRIMARY KEY,
  species VARCHAR(32) NOT NULL,
  name VARCHAR(32) NOT NULL,
  gen INT NOT NULL,
  age INT NOT NULL,
  eaten INT NOT NULL,
  ended_tick BIGINT NOT NULL,
  brain LONGTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (species),
  INDEX (ended_tick)
) CHARACTER SET utf8mb4;
