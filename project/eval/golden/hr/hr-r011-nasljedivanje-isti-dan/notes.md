# hr-r011: promjena stiže istoga dana

Dva zapisa u jednom danu, šest sati razmaka, bez intervala valjanosti.
Zaštita smjera uspoređuje vrijeme događaja, a bez `valid_from` to je vrijeme
zapisa: par prolazi samo ako usporedba zadrži punu vremensku preciznost
umjesto da se svede na kalendarski dan.

`valid_from` je namjerno izostavljen. S njim bi vrijeme događaja s obje strane
bilo isti datum, zaštita bi izjednačila parove, i slučaj više ne bi mjerio
poredak unutar dana nego razrješenje izjednačenja. To je drugi slučaj.
