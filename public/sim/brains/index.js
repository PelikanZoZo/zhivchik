// Разъём для мозгов. Любой мозг обязан уметь:
//   act(sensors)  -> поворот в диапазоне [-1, 1]
//   learn(exp)    -> учится на опыте, возвращает заметные события (для журнала)
//   onDeath()     -> последний урок перед смертью
//   child()       -> новый мозг для потомка
//   summary()     -> что показать в интерфейсе
//   toJSON()      -> для сохранения в базу
// Тело и мир не знают, какой мозг внутри. Новый мозг = новый файл + строчка ниже.

import { AssociativeBrain } from "./associative.js";
import { NeuralBrain } from "./neural.js";

export const BRAINS = {
  [AssociativeBrain.type]: AssociativeBrain,
  [NeuralBrain.type]: NeuralBrain,
};

export function createBrain(type, data) {
  const B = BRAINS[type];
  if (!B) throw new Error("Неизвестный мозг: " + type);
  return new B(data);
}
