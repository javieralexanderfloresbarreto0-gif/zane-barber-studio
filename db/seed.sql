INSERT INTO styles (name, category, image_url)
SELECT 'Fade clásico', 'cortes', 'images/Imagen de un corte.jpeg'
WHERE NOT EXISTS (SELECT 1 FROM styles WHERE name = 'Fade clásico');

INSERT INTO styles (name, category, image_url)
SELECT 'Barba perfilada', 'barba', 'images/Imagen pegada.png'
WHERE NOT EXISTS (SELECT 1 FROM styles WHERE name = 'Barba perfilada');

INSERT INTO styles (name, category, image_url)
SELECT 'Combo completo', 'combos', 'images/Imagen del Lobby de la barberia.jpeg'
WHERE NOT EXISTS (SELECT 1 FROM styles WHERE name = 'Combo completo');
