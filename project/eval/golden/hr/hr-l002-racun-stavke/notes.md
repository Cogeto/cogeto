# hr-l002 — stavke i dospijeće računa (issue #499)

Hrvatski par en-l002 slučaja: račun-otpremnica sa stavkama u razmakom
poravnatim kolonama, dospijećem i ukupnim iznosom. Pitanje koje je otvorilo
cijelu jedinicu ("koliko smo platili X i u kojoj količini", "kada dospijeva")
mora biti odgovorivo iz ovih činjenica. Zaglavlje je isključeno prozom u
must_not_extract i mjeri se preciznošću; bodovana igla je isprobana i
uklonjena jer igla pretražuje i doslovni source_span, pa raspon koji prelazi
preko retka zaglavlja lažno aktivira gate nulte tolerancije.
