INSERT INTO styles (name, category, image_url)
SELECT 'Fade clásico', 'cortes', 'img/galeria/fade-detalle.jpeg'
WHERE NOT EXISTS (SELECT 1 FROM styles WHERE name = 'Fade clásico');

INSERT INTO styles (name, category, image_url)
SELECT 'Barba perfilada', 'barba', 'img/hero.png'
WHERE NOT EXISTS (SELECT 1 FROM styles WHERE name = 'Barba perfilada');

INSERT INTO styles (name, category, image_url)
SELECT 'Combo completo', 'combos', 'img/galeria/zona-lounge.jpeg'
WHERE NOT EXISTS (SELECT 1 FROM styles WHERE name = 'Combo completo');
